-- 2B-G3 (#249): guest-staff chat. A message is stored per visit and announced only by the queue's
-- PII-free version bump (pulse and loc signals); guests fetch through token RPCs. Chat is not a
-- state change, so nothing is written to visit_events.
--
-- Alternatives rejected: (1) a message event per row in visit_events: chat is free text and events
-- are immutable, which would make erasure impossible; (2) a per-visit realtime topic: guests
-- would hold one more socket, and the Free tier caps sockets (realtime-limits). api.visit_status
-- gains trailing chat_version (highest message id) and unread_staff_messages; no signature changes.

alter table app.queues add column chat_enabled boolean not null default false;
comment on column app.queues.chat_enabled is
  'When true, guests of this queue and staff can exchange short messages about a visit.';

alter type api.visit_status
  add attribute chat_version bigint,
  add attribute unread_staff_messages int;

create table app.visit_messages (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  location_id uuid not null,
  visit_id uuid not null,
  sender text not null check (sender in ('guest', 'staff')),
  staff_user_id uuid references auth.users (id) on delete set null,
  body varchar(500) not null check (length(btrim(body)) > 0),
  idempotency_key uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  foreign key (org_id, visit_id) references app.visits (org_id, id),
  foreign key (org_id, location_id) references app.locations (org_id, id),
  unique (visit_id, sender, idempotency_key)
);
create index visit_messages_visit_idx on app.visit_messages (visit_id, id);
create index visit_messages_location_idx on app.visit_messages (location_id, created_at desc);
comment on table app.visit_messages is
  'Chat between a guest (by token) and staff, per visit. Free text, so personal data: deleted after '
  '90 days (ops.chat_retention_tick) and when the visit is anonymized. Written only by the chat '
  'RPCs; staff of the location read. Never in realtime payloads, notifications or logs.';

create trigger forbid_org_change before update on app.visit_messages
  for each row execute function private.forbid_org_change();

revoke insert, update, delete, truncate on app.visit_messages from authenticated;
alter table app.visit_messages enable row level security;
create policy visit_messages_select on app.visit_messages for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));

-- redefines private.visit_status from 20261030173016_companions.sql
create or replace function private.visit_status(p_visit app.visits) returns api.visit_status
language sql stable set search_path = '' as $$
  select p_visit.display_ticket, p_visit.status, pos.n, pos.n - 1,
         e.eta_state, e.eta_low, e.eta_high,
         case when p_visit.status in ('called', 'serving') then c.label end,
         p_visit.call_count, p_visit.called_at, q.name, l.name, q.pulse_id,
         case when q.max_snoozes = 0
              then array_remove(private.guest_actions(p_visit.status), 'need_more_time'::api.guest_action)
              else private.guest_actions(p_visit.status) end,
         p_visit.version, now(),
         case when p_visit.status = 'called' then p_visit.grace_until end,
         case when p_visit.status = 'called' and p_visit.grace_until is not null
              then p_visit.grace_until - make_interval(secs => q.no_show_warning_seconds) end,
         case when p_visit.status in ('waiting', 'called') then greatest(q.max_snoozes - p_visit.snooze_count, 0) end,
         private.visit_on_the_way(p_visit.id, p_visit.status, p_visit.call_count),
         (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'first_name', k.first_name)
                                    order by k.created_at, k.id), '[]')
          from app.visit_companions k where k.visit_id = p_visit.id),
         (select coalesce(max(m.id), 0) from app.visit_messages m where m.visit_id = p_visit.id),
         (select count(*)::int from app.visit_messages m
          where m.visit_id = p_visit.id and m.sender = 'staff' and m.read_at is null)
  from app.queues q
  join app.locations l on l.id = q.location_id
  left join app.counters c on c.id = p_visit.counter_id
  cross join lateral (select private.visit_position(p_visit) as n) pos
  cross join lateral private.visit_eta(p_visit.id) e
  where q.id = p_visit.queue_id
$$;
comment on function private.visit_status(app.visits) is
  'The api.visit_status a guest sees for p_visit: no guest name, contact or other guests. The '
  'counter label only while called or serving; position and ETA only while waiting. While called: '
  'grace_until (arrive by) and warn_at (when to start warning); while waiting or called: '
  'snoozes_left; need_more_time is not offered when the queue allows no snoozes; on_the_way is '
  'true after on_my_way for the current call; companions is the party''s [{id, first_name}], '
  'for the token holder only; chat_version is the highest chat message id and '
  'unread_staff_messages the staff messages the guest has not fetched yet.';

-- redefines private.anonymize_visits from 20261030173016_companions.sql
create or replace function private.anonymize_visits(p_org_id uuid, p_visit_ids uuid[]) returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_ids uuid[];
begin
  perform private.set_actor('system', null, 'anonymized', 'retention');
  with u as (
    update app.visits set guest_name = null, guest_id = null, contact_id = null,
                          guest_phone_e164 = null, guest_email = null, device_key_hash = null,
                          notes = null, tags = '{}', anonymized_at = now()
    where org_id = p_org_id and id = any (p_visit_ids) and anonymized_at is null
    returning id
  )
  select array_agg(id) into v_ids from u;
  if v_ids is null then
    return 0;
  end if;
  perform set_config('app.retention', 'on', true);
  update app.visit_events
  set payload = payload - array['name', 'guest_name', 'first_name', 'phone', 'phone_e164', 'email',
                                'contact', 'answers']
  where org_id = p_org_id and visit_id = any (v_ids);
  perform set_config('app.retention', '', true);
  update app.notifications set vars = '{}', recipient_hash = null
  where org_id = p_org_id and visit_id = any (v_ids);
  delete from app.visit_companions where org_id = p_org_id and visit_id = any (v_ids);
  delete from app.visit_messages where org_id = p_org_id and visit_id = any (v_ids);
  update app.visit_feedback set comment = null where org_id = p_org_id and visit_id = any (v_ids);
  return cardinality(v_ids);
end $$;
comment on function private.anonymize_visits(uuid, uuid[]) is
  'Strips personal data from visits of one org (see body), notes, companions, chat messages and '
  'feedback comments included; one anonymized event each. Idempotent. Used by the retention job and '
  'guest erasure. Not exposed.';

/** Whether a visit still takes chat: not ended, or ended less than 2 hours ago. */
create function private.chat_open(p_visit app.visits) returns boolean
language sql stable set search_path = '' as $$
  select p_visit.anonymized_at is null and (
         p_visit.status not in ('served', 'no_show', 'cancelled', 'removed', 'expired')
      or coalesce(p_visit.finished_at, (select max(e.occurred_at) from app.visit_events e where e.visit_id = p_visit.id))
         >= now() - interval '2 hours')
$$;
revoke all on function private.chat_open(app.visits) from public, anon, authenticated;

-- redefines api.guest_send_message from 20261030162713_api_contracts_2b.sql
create or replace function api.guest_send_message(p_token text, p_body text, p_idempotency_key uuid)
returns api.chat_message
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_body text := btrim(p_body);
  m app.visit_messages;
begin
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  if p_idempotency_key is null or v_body is null or length(v_body) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;
  -- Visit first, the queue last (the bump below): the order guest_act's leave and the companion
  -- functions use, and the one private.bump_queue_version documents.
  v := private.visit_by_token(p_token, true);
  if not private.chat_open(v) then
    raise exception 'not_found';
  end if;
  if not (select q.chat_enabled from app.queues q where q.id = v.queue_id) then
    raise exception 'chat_disabled';
  end if;
  select * into m from app.visit_messages
  where visit_id = v.id and sender = 'guest' and idempotency_key = p_idempotency_key;
  if not found then
    if (select count(*) from app.visit_messages
        where visit_id = v.id and sender = 'guest' and created_at > now() - interval '5 minutes') >= 10 then
      raise exception 'rate_limited';
    end if;
    -- Each message bumps the queue version, which signals every subscriber, so the location as a
    -- whole is capped too: many visits cannot multiply the per-visit limit.
    if (select count(*) from app.visit_messages
        where location_id = v.location_id and sender = 'guest' and created_at > now() - interval '1 minute') >= 120 then
      raise exception 'rate_limited';
    end if;
    insert into app.visit_messages (org_id, location_id, visit_id, sender, body, idempotency_key)
    values (v.org_id, v.location_id, v.id, 'guest', v_body, p_idempotency_key)
    returning * into m;
    perform private.bump_queue_version(v.queue_id);
  end if;
  return row(m.id, m.visit_id, m.sender, m.body, m.created_at, m.read_at)::api.chat_message;
end $$;
comment on function api.guest_send_message(text, text, uuid) is
  'Sends a guest message (1-500 characters) on the token''s visit while it is open or ended less than '
  '2 hours ago. At most 10 per visit per 5 minutes and 120 per location per minute. A repeated key returns the first message. Raises '
  'not_found (unknown token or chat window over), invalid_input, chat_disabled, rate_limited. '
  'Implemented in 2B-G3 (#249).';

-- redefines api.guest_list_messages from 20261030162713_api_contracts_2b.sql
create or replace function api.guest_list_messages(p_token text, p_after_id bigint default 0)
returns setof api.chat_message
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_max bigint;
begin
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  v := private.visit_by_token(p_token);
  if not private.chat_open(v) then
    raise exception 'not_found';
  end if;
  select max(id) into v_max from app.visit_messages where visit_id = v.id;
  update app.visit_messages set read_at = now()
  where visit_id = v.id and sender = 'staff' and read_at is null and id <= coalesce(v_max, 0)
    and id > coalesce(p_after_id, 0);
  return query
    select m.id, m.visit_id, m.sender, m.body::text, m.created_at, m.read_at
    from app.visit_messages m
    where m.visit_id = v.id and m.id > coalesce(p_after_id, 0)
    order by m.id;
end $$;
comment on function api.guest_list_messages(text, bigint) is
  'The token''s chat messages after p_after_id, oldest first, from this visit only (sender is guest '
  'or staff, no staff identity). Fetching marks the staff messages it returns as read. Raises '
  'not_found for an unknown token or once the 2-hour chat window after the visit ended is over. '
  'Implemented in 2B-G3 (#249).';

-- redefines api.staff_send_message from 20261030162713_api_contracts_2b.sql
create or replace function api.staff_send_message(p_visit_id uuid, p_body text, p_idempotency_key uuid)
returns api.chat_message
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_body text := btrim(p_body);
  m app.visit_messages;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_idempotency_key is null or v_body is null or length(v_body) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;
  perform 1 from app.queues where id = v.queue_id for update;
  select * into v from app.visits where id = p_visit_id for update;
  if not private.chat_open(v) then
    raise exception 'illegal_transition' using detail = 'chat is closed for this visit';
  end if;
  if not (select q.chat_enabled from app.queues q where q.id = v.queue_id) then
    raise exception 'chat_disabled';
  end if;
  select * into m from app.visit_messages
  where visit_id = v.id and sender = 'staff' and idempotency_key = p_idempotency_key;
  if not found then
    insert into app.visit_messages (org_id, location_id, visit_id, sender, staff_user_id, body, idempotency_key)
    values (v.org_id, v.location_id, v.id, 'staff', (select auth.uid()), v_body, p_idempotency_key)
    returning * into m;
    perform private.bump_queue_version(v.queue_id);
  end if;
  return row(m.id, m.visit_id, m.sender, m.body, m.created_at, m.read_at)::api.chat_message;
end $$;
comment on function api.staff_send_message(uuid, text, uuid) is
  'Sends a staff message (1-500 characters) on a visit of the caller''s location while the visit is '
  'open or ended less than 2 hours ago. A repeated key returns the first message. Raises not_found '
  '(unknown or foreign visit), invalid_input, chat_disabled, illegal_transition (chat window over). '
  'Implemented in 2B-G3 (#249).';

-- redefines api.staff_mark_read from 20261030162713_api_contracts_2b.sql
create or replace function api.staff_mark_read(p_visit_id uuid, p_up_to_id bigint)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  update app.visit_messages set read_at = now()
  where visit_id = v.id and sender = 'guest' and read_at is null and id <= coalesce(p_up_to_id, 0);
end $$;
comment on function api.staff_mark_read(uuid, bigint) is
  'Marks the visit''s guest messages up to p_up_to_id read; repeating changes nothing. Raises '
  'not_found for an unknown or foreign visit. Implemented in 2B-G3 (#249).';

create function ops.chat_retention_tick() returns int
language sql volatile set search_path = '' as $$
  with d as (delete from app.visit_messages where created_at < now() - interval '90 days' returning 1)
  select count(*)::int from d
$$;
comment on function ops.chat_retention_tick() is
  'Daily: deletes chat messages older than 90 days. Returns rows deleted. Not callable via the API.';
revoke all on function ops.chat_retention_tick() from public, anon, authenticated;
select cron.schedule('chat-retention', '41 2 * * *', 'select ops.chat_retention_tick()');

notify pgrst, 'reload schema';

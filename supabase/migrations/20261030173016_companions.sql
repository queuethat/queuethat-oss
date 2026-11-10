-- 2B-J5 (#243): companions. A party lists up to 9 companions by first name; the guest (token) and
-- staff can edit them. party_size follows the list (1 + companions) and every change writes one
-- party_changed event carrying counts only, never names (X-3).
--
-- Alternatives rejected: (1) a companions array column on app.visits: the visit guard and column
-- grants would need to learn a free-text column, and erasure/retention could not delete rows;
-- (2) a new guest RPC to read the list: the status call already assembles everything the token
-- holder sees, so api.visit_status gains a trailing `companions` attribute (additive, like
-- grace_until before it); no signature changes.

alter type api.visit_status add attribute companions jsonb;

create table app.visit_companions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  visit_id uuid not null,
  first_name varchar(40) not null check (length(btrim(first_name)) > 0),
  idempotency_key uuid,
  created_at timestamptz not null default now(),
  foreign key (org_id, visit_id) references app.visits (org_id, id),
  unique (visit_id, idempotency_key)
);
create index visit_companions_visit_idx on app.visit_companions (visit_id, created_at);
comment on table app.visit_companions is
  'First names of the other people in a party (max 9 per visit). Personal data: deleted when the '
  'visit is anonymized. Written only by api.guest_add_companion, guest_remove_companion and '
  'staff_set_companions; staff read. Never in display data, notifications or event payloads.';

create trigger forbid_org_change before update on app.visit_companions
  for each row execute function private.forbid_org_change();

revoke insert, update, delete, truncate on app.visit_companions from authenticated;
alter table app.visit_companions enable row level security;
create policy visit_companions_select on app.visit_companions for select to authenticated
  using (exists (select 1 from app.visits v where v.id = visit_id
                 and (select private.has_role(v.org_id, v.location_id, 'staff'))));

/**
 * Makes the visit's party_size match its companions (1 + their number; 1 when none) and records one
 * party_changed event with the counts. Rejects a size above the queue's maximum when the queue asks
 * for party size. Caller holds the visit row lock and has called nothing else on the actor.
 */
create function private.sync_party(p_visit app.visits, p_actor_kind app.actor_kind, p_actor_id uuid)
returns app.visits
language plpgsql volatile set search_path = '' as $$
declare
  v app.visits := p_visit;
  n int;
  q app.queues;
begin
  select count(*) into n from app.visit_companions where visit_id = v.id;
  if n > 9 then
    raise exception 'party_limit';
  end if;
  if 1 + n = v.party_size or (n = 0 and v.party_size = 1) then
    return v;
  end if;
  select * into q from app.queues where id = v.queue_id;
  if n > 0 and q.party_size_enabled and 1 + n > q.party_size_max then
    raise exception 'party_size_out_of_range';
  end if;
  perform private.set_actor(p_actor_kind, p_actor_id, 'party_changed', null,
    jsonb_build_object('from', v.party_size, 'to', 1 + n, 'companions', n));
  update app.visits set party_size = 1 + n where id = v.id returning * into v;
  return v;
end $$;
comment on function private.sync_party(app.visits, app.actor_kind, uuid) is
  'Sets party_size to 1 + companions with one party_changed event (counts only); no-op when equal.';
revoke all on function private.sync_party(app.visits, app.actor_kind, uuid) from public, anon, authenticated;

-- redefines private.visit_status from 20261030115001_guest_snooze_status.sql
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
          from app.visit_companions k where k.visit_id = p_visit.id)
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
  'for the token holder only.';

-- redefines api.guest_add_companion from 20261030162713_api_contracts_2b.sql
create or replace function api.guest_add_companion(p_token text, p_first_name text, p_idempotency_key uuid)
returns api.visit_status
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_name text := btrim(p_first_name);
begin
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  if p_idempotency_key is null or v_name is null or length(v_name) not between 1 and 40 then
    raise exception 'invalid_input';
  end if;
  v := private.visit_by_token(p_token, true);
  if v.status not in ('waiting', 'called', 'expected') then
    raise exception 'illegal_transition' using detail = format('add a companion to a %s visit', v.status);
  end if;
  if exists (select 1 from app.visit_companions where visit_id = v.id and idempotency_key = p_idempotency_key) then
    return private.visit_status(v);
  end if;
  if (select count(*) from app.visit_companions where visit_id = v.id) >= 9 then
    raise exception 'party_limit';
  end if;
  insert into app.visit_companions (org_id, visit_id, first_name, idempotency_key)
  values (v.org_id, v.id, v_name, p_idempotency_key);
  v := private.sync_party(v, 'guest', null);
  return private.visit_status(v);
end $$;
comment on function api.guest_add_companion(text, text, uuid) is
  'Adds a companion (first name, 1-40 characters) to the token''s party; party_size becomes 1 + '
  'companions with one party_changed event. Waiting, called or expected visits only. A repeated '
  'key adds nothing. Raises not_found (unknown or expired token), invalid_input, illegal_transition '
  '(visit ended), party_limit (more than 9), party_size_out_of_range (above the queue''s maximum). '
  'Implemented in 2B-J5 (#243).';

-- redefines api.guest_remove_companion from 20261030162713_api_contracts_2b.sql
create or replace function api.guest_remove_companion(p_token text, p_companion_id uuid)
returns api.visit_status
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
begin
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  v := private.visit_by_token(p_token, true);
  if v.status not in ('waiting', 'called', 'expected') then
    return private.visit_status(v);
  end if;
  delete from app.visit_companions where id = p_companion_id and visit_id = v.id;
  v := private.sync_party(v, 'guest', null);
  return private.visit_status(v);
end $$;
comment on function api.guest_remove_companion(text, uuid) is
  'Removes a companion from the token''s party and re-sizes it; an unknown companion, a repeat or an '
  'ended visit changes nothing. Raises not_found for an unknown or expired token. Implemented in '
  '2B-J5 (#243).';

-- redefines api.staff_set_companions from 20261030162713_api_contracts_2b.sql
create or replace function api.staff_set_companions(p_visit_id uuid, p_names text[], p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  v_names text[];
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null or p_names is null then
    raise exception 'invalid_input';
  end if;
  select coalesce(array_agg(n), '{}') into v_names
  from (select btrim(x) n from unnest(p_names) x) s where n <> '';
  if exists (select 1 from unnest(v_names) n where length(n) > 40) then
    raise exception 'invalid_input';
  end if;
  if cardinality(v_names) > 9 then
    raise exception 'party_limit';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'staff_set_companions', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status not in ('waiting', 'called', 'serving', 'expected') then
    raise exception 'illegal_transition' using detail = format('edit companions of a %s visit', v.status);
  end if;

  delete from app.visit_companions where visit_id = v.id;
  insert into app.visit_companions (org_id, visit_id, first_name)
  select v.org_id, v.id, n from unnest(v_names) with ordinality t(n, o) order by o;
  v := private.sync_party(v, 'staff', (select auth.uid()));

  result := private.visit_row(v.id);
  perform private.save_idempotent('staff_set_companions', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.staff_set_companions(uuid, text[], int, uuid) is
  'Replaces the visit''s companions with p_names (trimmed, blanks dropped, each 1-40 characters, at '
  'most 9) and re-sizes the party. Staff of the location. Raises not_found for unknown or foreign '
  'visits, invalid_input, party_limit, party_size_out_of_range, stale_visit, illegal_transition for '
  'a finished visit. Idempotent per key. Implemented in 2B-J5 (#243).';

-- redefines private.anonymize_visits from 20261030073600_notes_history.sql
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
  update app.visit_feedback set comment = null where org_id = p_org_id and visit_id = any (v_ids);
  return cardinality(v_ids);
end $$;
comment on function private.anonymize_visits(uuid, uuid[]) is
  'Strips personal data from visits of one org (see body), notes, companions and feedback comments '
  'included; one anonymized event each. Idempotent. Used by the retention job and guest erasure. '
  'Not exposed.';

notify pgrst, 'reload schema';

-- 2A-Q7 (#106): custom intake fields, answers and validation in join (Q-8).
--
-- redefines private.join_core from 20261030073000_block_list.sql
-- redefines api.set_visit_answers from 20261030045508_api_contracts_2a.sql
-- Answers can be special-category data (clinics), so they live in their own table that a
-- retention job can purge without touching statistics, and no trigger logs their values.

create type app.intake_field_type as enum ('text', 'select', 'checkbox', 'phone', 'number', 'date');
create type app.intake_visibility as enum ('guest', 'staff_only');
grant usage on type app.intake_field_type, app.intake_visibility to authenticated, service_role;

create table app.intake_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  queue_id uuid not null,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null check (length(btrim(label)) between 1 and 120),
  help text check (length(help) <= 300),
  type app.intake_field_type not null,
  -- select only: a non-empty array of distinct option strings
  options jsonb,
  required boolean not null default false,
  visibility app.intake_visibility not null default 'guest',
  position int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id, queue_id) references app.queues (org_id, location_id, id) on delete cascade,
  unique (queue_id, key),
  unique (org_id, id),
  constraint intake_fields_options_check check ((type = 'select') = (options is not null))
);
create index intake_fields_queue_idx on app.intake_fields (queue_id);

create function private.check_intake_field() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.type = 'select' and (
    jsonb_typeof(new.options) <> 'array'
    or jsonb_array_length(new.options) not between 1 and 50
    or exists (select 1 from jsonb_array_elements(new.options) o
               where jsonb_typeof(o) <> 'string' or length(btrim(o #>> '{}')) not between 1 and 80)
    or (select count(distinct o) from jsonb_array_elements(new.options) o) <> jsonb_array_length(new.options)
  ) then
    raise exception 'invalid_input' using detail = 'options';
  end if;
  if tg_op = 'INSERT' and (select count(*) from app.intake_fields f where f.queue_id = new.queue_id) >= 20 then
    raise exception 'invalid_input' using detail = 'too many fields';
  end if;
  return new;
end $$;
comment on function private.check_intake_field() is
  'BEFORE trigger on app.intake_fields: select options are 1 to 50 distinct non-empty strings of '
  'at most 80 characters; a queue has at most 20 fields.';
create trigger check_intake_field before insert or update on app.intake_fields
  for each row execute function private.check_intake_field();
create trigger forbid_org_change before update on app.intake_fields
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.intake_fields
  for each row execute function private.audit_row();

alter table app.intake_fields enable row level security;
revoke delete, truncate on app.intake_fields from authenticated;
create policy intake_fields_select on app.intake_fields for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff'))
         or (select private.is_device(org_id, location_id)));
create policy intake_fields_insert on app.intake_fields for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy intake_fields_update on app.intake_fields for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));

-- No audit trigger here: audit_log would copy the answers.
create unique index visits_org_location_id_idx on app.visits (org_id, location_id, id);
create table app.visit_answers (
  visit_id uuid primary key,
  org_id uuid not null,
  location_id uuid not null,
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  updated_at timestamptz not null default now(),
  foreign key (org_id, location_id, visit_id) references app.visits (org_id, location_id, id)
);
create trigger touch_updated_at before update on app.visit_answers
  for each row execute function private.touch_updated_at();
create trigger forbid_org_change before update on app.visit_answers
  for each row execute function private.forbid_org_change();

alter table app.visit_answers enable row level security;
-- Only join and set_visit_answers write answers.
revoke insert, update, delete, truncate on app.visit_answers from authenticated;
create policy visit_answers_select on app.visit_answers for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));

------------------------------------------------------------------------------------------------
-- Validation
------------------------------------------------------------------------------------------------

create function private.validate_answers(p_queue_id uuid, p_answers jsonb, p_audience text)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  a jsonb := coalesce(p_answers, '{}');
  f app.intake_fields;
  k text;
  val jsonb;
  s text;
  out jsonb := '{}';
begin
  if p_audience not in ('guest', 'staff') then
    raise exception 'invalid_input';
  end if;
  if jsonb_typeof(a) = 'null' then
    a := '{}';
  end if;
  -- Bounded before any work: a queue has at most 20 fields, so more keys cannot all be valid.
  if jsonb_typeof(a) <> 'object' or octet_length(a::text) > 16384 then
    raise exception 'invalid_answers' using detail = '';
  end if;

  -- Every key must name an active field this audience may answer.
  for k in select jsonb_object_keys(a) loop
    select * into f from app.intake_fields x where x.queue_id = p_queue_id and x.key = k and x.active;
    if not found or (p_audience = 'guest' and f.visibility = 'staff_only') then
      -- Echo only what looks like a field key, never arbitrary guest text.
      raise exception 'invalid_answers' using detail = case when k ~ '^[a-z][a-z0-9_]{0,39}$' then k else '' end;
    end if;
  end loop;

  for f in select * from app.intake_fields x where x.queue_id = p_queue_id and x.active order by x.position, x.key loop
    val := a -> f.key;
    -- null, an empty string and false count as not answered
    if val is null or val = 'null'::jsonb or (f.type = 'checkbox' and val = 'false'::jsonb)
       or (jsonb_typeof(val) = 'string' and btrim(val #>> '{}') = '') then
      if f.required and p_audience = 'guest' and f.visibility = 'guest' then
        raise exception 'invalid_answers' using detail = f.key;
      end if;
      continue;
    end if;

    case f.type
      when 'text' then
        if jsonb_typeof(val) <> 'string' then raise exception 'invalid_answers' using detail = f.key; end if;
        s := btrim(val #>> '{}');
        if length(s) > 500 or s ~ '[[:cntrl:]]' then raise exception 'invalid_answers' using detail = f.key; end if;
        if s <> '' then out := out || jsonb_build_object(f.key, s); end if;
      when 'select' then
        if jsonb_typeof(val) <> 'string' or not f.options @> jsonb_build_array(val) then
          raise exception 'invalid_answers' using detail = f.key;
        end if;
        out := out || jsonb_build_object(f.key, val);
      when 'checkbox' then
        if jsonb_typeof(val) <> 'boolean' then raise exception 'invalid_answers' using detail = f.key; end if;
        out := out || jsonb_build_object(f.key, val);
      when 'phone' then
        if jsonb_typeof(val) <> 'string' then raise exception 'invalid_answers' using detail = f.key; end if;
        s := regexp_replace(val #>> '{}', '[[:space:]().-]', '', 'g');
        if s !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid_answers' using detail = f.key; end if;
        out := out || jsonb_build_object(f.key, s);
      when 'number' then
        if jsonb_typeof(val) <> 'number' or abs((val #>> '{}')::numeric) > 1000000000000 then
          raise exception 'invalid_answers' using detail = f.key;
        end if;
        out := out || jsonb_build_object(f.key, val);
      when 'date' then
        s := val #>> '{}';
        if jsonb_typeof(val) <> 'string' or s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise exception 'invalid_answers' using detail = f.key;
        end if;
        begin
          perform s::date;
        exception when others then
          raise exception 'invalid_answers' using detail = f.key;
        end;
        out := out || jsonb_build_object(f.key, s);
    end case;
  end loop;
  return out;
end $$;
comment on function private.validate_answers(uuid, jsonb, text) is
  'Checks intake answers against the queue''s active fields and returns them normalised (blank '
  'answers dropped, phones as E.164). p_audience guest (join: staff-only fields refused, required '
  'guest fields enforced) or staff (set_visit_answers and staff adds: any active field, nothing '
  'required). Unknown, inactive or wrongly typed answers raise invalid_answers with the failing '
  'key as DETAIL (never the value). Text is at most 500 characters.';
revoke all on function private.validate_answers(uuid, jsonb, text) from public, anon, authenticated;

-- The questions a guest may be asked, for the join form (2A-GST8 puts them in get_location_wait).
create function private.guest_intake_fields(p_queue_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', f.key, 'label', f.label, 'help', f.help, 'type', f.type,
           'options', f.options, 'required', f.required) order by f.position, f.key), '[]')
  from app.intake_fields f
  where f.queue_id = p_queue_id and f.active and f.visibility = 'guest'
$$;
comment on function private.guest_intake_fields(uuid) is
  'Active guest-visible intake fields of a queue as a jsonb array (key, label, help, type, '
  'options, required), in position order. Never includes staff-only fields.';
revoke all on function private.guest_intake_fields(uuid) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- set_visit_answers
------------------------------------------------------------------------------------------------

create or replace function api.set_visit_answers(p_visit_id uuid, p_answers jsonb, p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  v_answers jsonb;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;
  v_answers := private.validate_answers(v.queue_id, p_answers, 'staff');

  select * into claim from private.claim_idempotent(v.org_id, 'set_visit_answers', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;

  if v_answers = '{}' then
    delete from app.visit_answers where visit_id = v.id;
  else
    insert into app.visit_answers (org_id, location_id, visit_id, answers)
    values (v.org_id, v.location_id, v.id, v_answers)
    on conflict (visit_id) do update set answers = excluded.answers;
  end if;
  -- The event names the answered keys, never the values.
  perform private.set_actor('staff', (select auth.uid()));
  perform private.record_visit_event(v.id, 'answers_updated',
                                     jsonb_build_object('keys', (select coalesce(jsonb_agg(k order by k), '[]') from jsonb_object_keys(v_answers) k)));

  result := private.visit_row(v.id);
  perform private.save_idempotent('set_visit_answers', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.set_visit_answers(uuid, jsonb, int, uuid) is
  'Replaces the intake answers of the visit after validating them against the queue''s active '
  'fields (any visibility; nothing is required). Staff of the location. Writes an answers_updated '
  'event that names the keys and never the values. Raises invalid_answers (DETAIL: the failing '
  'key), stale_visit, not_found, invalid_input without a version or key. Idempotent per key. '
  'Implemented by 2A-Q7 (#106).';

------------------------------------------------------------------------------------------------
-- join_core stores validated answers
------------------------------------------------------------------------------------------------

create or replace function private.join_core(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid,
  p_source text,
  p_actor_kind app.actor_kind,
  p_actor_id uuid,
  p_device_key text default null,
  p_answers jsonb default '{}'::jsonb,
  p_group_key uuid default null,
  p_onsite_code text default null,
  out visit_id uuid,
  out token text
)
language plpgsql volatile set search_path = '' as $$
declare
  q app.queues;
  v_name text := nullif(btrim(p_name), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone_e164, ''), '[[:space:]().-]', '', 'g'), '');
  v_email text := nullif(lower(btrim(p_email)), '');
  v_party int := coalesce(p_party_size, 1);
  v_locale text := nullif(btrim(p_locale), '');
  v_device text := nullif(btrim(p_device_key), '');
  v_device_hash bytea;
  v_reason text;
  v_day date;
  v_number int;
  v_sort bigint;
  v_guest uuid;
  v_contact uuid;
  v_email_contact uuid;
  v_answers jsonb;
  prior app.visits;
  l app.locations;
begin
  -- Input. Blank name, phone, email, locale or device key count as not given.
  if p_idempotency_key is null
     or length(v_name) > 60 or v_name ~ '[[:cntrl:]]'
     or v_phone !~ '^\+[1-9][0-9]{6,14}$'
     -- Plain ASCII local@domain only (#479 re-review): no quoted local parts, comments, IP
     -- literals, trailing dots or look-alike letters, so canonical_email and the block list see
     -- every address the way mail servers route it.
     or length(v_email) > 254
     or v_email !~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$'
     or v_party not between 1 and 50
     or length(v_locale) > 35 or v_locale !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$'
     or v_device !~ '^[A-Za-z0-9_-]{22,128}$' then
    raise exception 'invalid_input';
  end if;
  -- Only an online join is one person's phone; a kiosk or a staff device serves many guests.
  if p_source <> 'online' then
    v_device := null;
  end if;

  -- FOR NO KEY UPDATE, first: joins to one queue run one at a time from here, so the capacity
  -- and rate counts below see every committed join and a repeated key or device finds the first
  -- visit; set_queue_state waits for in-flight joins; and bump_queue_version below needs no
  -- upgrade (upgrading from FOR SHARE deadlocks two concurrent joins).
  select * into q from app.queues where id = p_queue_id and archived_at is null for no key update;
  if not found then
    raise exception 'not_found';
  end if;
  if p_source = 'kiosk' and not private.is_device(q.org_id, q.location_id) then
    raise exception 'not_found';
  end if;
  if p_service_id is not null and not exists (
    select 1 from app.services s where s.id = p_service_id and s.queue_id = q.id and s.active
  ) then
    raise exception 'not_found';
  end if;
  v_device_hash := private.device_key_hash(q.id, v_device);

  -- The same key again, or the same phone with an active visit here: that visit, unchanged.
  select * into prior from app.visits v
  where v.queue_id = q.id and v.idempotency_key = p_idempotency_key;
  -- A group join (2A-J15A) is several people from one device: only the key replays it.
  if not found and v_device_hash is not null and p_group_key is null then
    select * into prior from app.visits v
    where v.queue_id = q.id and v.device_key_hash = v_device_hash
      and v.status in ('waiting', 'called', 'serving')
    order by v.joined_at desc
    limit 1;
  end if;
  if prior.id is not null then
    visit_id := prior.id;
    -- The token goes back only to the caller that joined: the same source (never a staff add's
    -- token to a guest) and, online, the same device. Staff can read idempotency keys, so the key
    -- alone must not return a guest's link. And only when it is the derived one (older visits').
    token := private.visit_token(prior.id, prior.idempotency_key);
    if p_source = 'staff' or prior.source is distinct from p_source
       or (p_source = 'online' and (v_device_hash is null or prior.device_key_hash is distinct from v_device_hash))
       or private.token_hash(token) is distinct from prior.guest_token_hash then
      token := null;
    end if;
    return;
  end if;

  v_reason := private.queue_not_accepting_reason(q.id);
  if v_reason = 'full' then
    raise exception 'capacity_reached';
  elsif v_reason = 'org_suspended' then
    raise exception 'org_suspended';
  elsif v_reason is not null then
    raise exception 'queue_not_accepting' using detail = v_reason;
  end if;

  -- 2A-JN5: public joins to a location that requires it must type the code on its TV (current or
  -- previous window). Checked after the accepting predicate and before any rate slot is taken, so
  -- a wrong code costs the caller nothing but the answer. Kiosk and staff joins are exempt.
  if p_source = 'online' then
    select * into l from app.locations where id = q.location_id;
    if l.onsite_code_required then
      if nullif(btrim(p_onsite_code), '') is null then
        raise exception 'onsite_code_required';
      elsif btrim(p_onsite_code) not in (private.onsite_code(l.id, now()),
                                         private.onsite_code(l.id, now() - make_interval(mins => l.onsite_code_rotate_minutes))) then
        raise exception 'onsite_code_invalid';
      end if;
    end if;
  end if;

  -- PLT8: a contact blocked across the platform gets the same answer as a per-client flood, so an
  -- abuser learns nothing. Staff adds are exempt (design 3.5: staff joins carry a block-list override).
  if p_source <> 'staff' and private.is_blocked(q.org_id, v_phone, v_email) then
    raise exception 'rate_limited' using detail = 'client';
  end if;

  -- 2P-PRV5: this org's own block list (phone, email, device). Online and kiosk joins get the answer
  -- a closed queue gives, so an abuser learns nothing; a staff add is refused with guest_blocked
  -- until the block is lifted.
  if private.is_org_blocked(q.org_id, q.id, v_phone, v_email, v_device_hash) then
    if p_source = 'staff' then
      raise exception 'guest_blocked';
    end if;
    raise exception 'queue_not_accepting' using detail = 'closed';
  end if;

  -- 2A-J15A: one phone (or, online, one device) may hold several active visits, up to the queue's
  -- cap; the cap is a bound on abuse, not a ban. Staff adds are exempt.
  if p_source <> 'staff' and (
    select count(*) from app.visits v
    where v.queue_id = q.id and v.status in ('waiting', 'called', 'serving')
      and ((v_phone is not null and v.guest_phone_e164 = v_phone)
           or (v_device_hash is not null and v.device_key_hash = v_device_hash))
  ) >= q.max_active_per_contact then
    raise exception 'too_many_active_visits';
  end if;

  -- 2A-Q7: intake answers are checked before a rate slot is taken, so a bad form costs nothing.
  v_answers := private.validate_answers(q.id, p_answers,
                                        case when p_source = 'staff' then 'staff' else 'guest' end);

  perform private.take_join_slot(q, p_source, v_device);

  -- Staff see the guest, so a staff add records (or links) the org's contact and guest. Any other
  -- join keeps the typed phone and email on the visit only.
  if p_source = 'staff' then
    if v_phone is not null then
      select c.contact_id, c.guest_id into v_contact, v_guest
      from private.ensure_contact(q.org_id, 'phone', v_phone, null, v_name, p_source, true) c;
    end if;
    if v_email is not null then
      select c.contact_id, coalesce(v_guest, c.guest_id) into v_email_contact, v_guest
      from private.ensure_contact(q.org_id, 'email', v_email, v_guest, v_name, p_source, true) c;
      v_contact := coalesce(v_contact, v_email_contact);
    end if;
  end if;

  if v_locale is null then
    select o.default_locale into v_locale from app.organizations o where o.id = q.org_id;
  end if;

  v_day := private.service_day(q.location_id);
  v_number := private.next_ticket(q.id, q.ticket_prefix, v_day);
  -- Spaced so a later reorder can take a midpoint. Called guests count: requeue keeps their place.
  select coalesce(max(v.sort_key), 0) + 1024 into v_sort
  from app.visits v
  where v.queue_id = q.id and v.status in ('waiting', 'called');

  visit_id := gen_random_uuid();
  token := private.visit_token(visit_id, p_idempotency_key);

  perform private.set_actor(p_actor_kind, p_actor_id, null, null, jsonb_build_object('source', p_source));
  insert into app.visits (id, org_id, location_id, queue_id, service_id, service_day, ticket_prefix,
                          ticket_number, display_ticket, status, sort_key, party_size, guest_name,
                          guest_id, contact_id, guest_phone_e164, guest_email, locale,
                          guest_token_hash, device_key_hash, source, idempotency_key, group_key)
  values (visit_id, q.org_id, q.location_id, q.id, p_service_id, v_day, q.ticket_prefix,
          v_number, q.ticket_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
          'waiting', v_sort, v_party, v_name,
          v_guest, v_contact, v_phone, v_email, v_locale,
          private.token_hash(token), v_device_hash, p_source, p_idempotency_key, p_group_key);
  if v_answers <> '{}' then
    insert into app.visit_answers (org_id, location_id, visit_id, answers)
    values (q.org_id, q.location_id, visit_id, v_answers);
  end if;
  perform private.bump_queue_version(q.id);
end $$;

comment on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text, jsonb, uuid, text) is
  'Adds a waiting visit for every join entry point, bumps the queue version, and returns its id '
  'and token (private.visit_token, stored only as private.token_hash). Repeating (queue, key), '
  'or an online join whose p_device_key has a waiting, called or serving visit on the queue, '
  'returns that visit and changes nothing, even after the queue stopped accepting; the token comes '
  'back only to the source that joined and, online, only with the same device key; never for '
  'staff adds; null for visits whose token the current secret does not derive. '
  'Concurrent joins to one queue are serialized and never deadlock. Order of checks: input '
  '(invalid_input; a device key is 22 to 128 base64url characters), queue and service (not_found; '
  'a kiosk outside the queue''s location, or of a non-active org, also gets not_found), replay, '
  'the accepting predicate (org_suspended when the org is not active, capacity_reached when full, '
  'queue_not_accepting with the reason as DETAIL), then the platform contact block list for '
  'non-staff sources (rate_limited, DETAIL client, the same answer as the per-client cap), then '
  'rate limits (rate_limited, DETAIL client, '
  'network, queue, queue_total or device): online joins at most 10 per IP and device and '
  'deployment_settings.per_network_joins (60) per IP per queue in 10 minutes; while the queue has join_rate_per_min online joins in the last minute only '
  'clients that have not joined it in 10 minutes get in, up to three times that rate; at most online_joins_per_hour (default 120) '
  'online joins per queue in any hour, from all clients together (visits staff removed don''t '
  'count); each kiosk '
  'join_rate_per_min per minute on its own; staff unlimited. Kiosk and staff joins ignore the '
  'device key. An email must be a plain ASCII local@domain (no quotes, comments, IP literals or '
  'trailing dot) of at most 254 characters. The phone and email are stored on the visit. Only '
  'staff adds also create or link the org''s guest_contacts row and guest. p_answers (intake) is validated against the queue''s active fields by private.validate_answers '
  '(invalid_answers with the failing key as DETAIL; staff-only fields are refused for guests; a staff add skips the required check) before a rate slot is taken, and stored in app.visit_answers. p_group_key links the visits of one group on the visit (a group join skips the device-key replay, so a parent can join several people; only the idempotency key replays it). A non-staff join raises too_many_active_visits when the phone or, online, the device already holds queues.max_active_per_contact waiting, called or serving visits on the queue. When the '
  'location requires an on-site code, an online join without the displayed code (current or previous window) '
  'raises onsite_code_required or onsite_code_invalid, after the accepting predicate and before rate limits; kiosk and staff joins are exempt. A kiosk device of another location gets not_found (checked via is_device). Next, the org''s block list (private.is_org_blocked): non-staff joins get queue_not_accepting with DETAIL closed, staff adds get guest_blocked.';

notify pgrst, 'reload schema';

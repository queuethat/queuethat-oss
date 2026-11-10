-- 2A-API1 (#87) and 2A-API2 (#88): every phase 2a guest, kiosk, display, staff and admin RPC with its
-- final signature. Bodies raise not_implemented; the phase 2a feature tickets replace them with
-- `create or replace` and must not change a signature or a return type.
--
-- join_queue and guest_act are extended, not duplicated (technical-design.md 3.5): join_queue
-- gains defaulted parameters, guest_act gains enum values. Old bundles pass named arguments, so
-- they keep working. New join parameters are accepted and ignored until their tickets land
-- (2A-Q5 answers, 2A-J15A group key, 2A-JN5 on-site code).

------------------------------------------------------------------------------------------------
-- Enum values
------------------------------------------------------------------------------------------------

-- Guest self-service actions (each is a guest_act branch). visit_action 'check_in' and its
-- expected -> waiting transition already exist (20261025000400_visits.sql).
alter type api.guest_action add value if not exists 'on_my_way';
alter type api.guest_action add value if not exists 'need_more_time';
alter type api.guest_action add value if not exists 'check_in';

------------------------------------------------------------------------------------------------
-- Return types
------------------------------------------------------------------------------------------------

-- Everything the visit link page needs that is not live status. No contact data.
create type api.visit_info as (
  location_name text,
  address text,
  phone text,
  directions_url text,
  hours_today jsonb,
  service_name text,
  scheduled_at timestamptz,
  scan_code text,
  group_key uuid,
  locale text
);

-- One queue's public wait, for signage and embeds. No guest data.
create type api.public_wait as (
  queue_id uuid,
  queue_name text,
  accepting boolean,
  waiting_count int,
  eta_low int,
  eta_high int,
  eta_state api.eta_state,
  opens_next_at timestamptz,
  as_of timestamptz
);

-- The rotating code a guest must type to join on site. Display devices and staff only.
create type api.onsite_code as (
  required boolean,
  code text,
  valid_until timestamptz
);

-- text rather than app enums so api types never expose app types.
create type api.visit_history_row as (
  occurred_at timestamptz,
  type text,
  from_status api.visit_state,
  to_status api.visit_state,
  actor_kind text,
  actor_label text,
  reason text,
  summary jsonb
);

create type api.invitation_row as (
  id uuid,
  org_id uuid,
  email text,
  role text,
  location_ids uuid[],
  display_name text,
  expires_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  -- The plaintext token, returned exactly once by create_invitation; null everywhere else.
  token text
);

create type api.membership_row as (
  id uuid,
  org_id uuid,
  user_id uuid,
  email text,
  display_name text,
  role text,
  -- null = every location in the org
  location_ids uuid[],
  has_pin boolean,
  created_at timestamptz,
  removed_at timestamptz
);

create type api.operator_session as (
  -- Sent as x-operator-token; stored only as a hash. Returned once.
  operator_token text,
  user_id uuid,
  display_name text,
  role text,
  expires_at timestamptz
);

create type api.industry_template as (
  key text,
  name text,
  description text,
  health_tagged boolean
);

create type api.template_result as (
  template_key text,
  queues_created int,
  services_created int,
  counters_created int
);

grant usage on type api.visit_info, api.public_wait to anon, authenticated, service_role;
grant usage on type api.onsite_code, api.visit_history_row, api.invitation_row, api.membership_row,
  api.operator_session, api.industry_template, api.template_result to authenticated, service_role;

------------------------------------------------------------------------------------------------
-- Guest, kiosk and display stubs (#87)
------------------------------------------------------------------------------------------------

create function api.get_visit_info(p_token text) returns api.visit_info
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.get_visit_info(text) is
  'The static details of the token''s visit: location name, address, phone, directions link, '
  'today''s hours, service, scheduled time, the scan code staff scan at the door, group key and '
  'locale. Live status stays in get_visit_status. Never includes contact data or other guests. '
  'Raises not_found for unknown or expired tokens, as get_visit_status does. Implemented by '
  '2A-GST1 and 2A-CHK1.';

create function api.get_location_wait(p_location_slug text) returns setof api.public_wait
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.get_location_wait(text) is
  'One row per non-archived queue of the location (or its redirected old slug): accepting, '
  'waiting count, the ETA triple, when it next opens, and the server time. Contains no guest '
  'data. Raises not_found for an unknown slug. Implemented by 2A-GST2.';

create function api.display_onsite_code(p_location_id uuid) returns api.onsite_code
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.display_onsite_code(uuid) is
  'The current on-site join code for the location and whether joins need one. Callable by a '
  'display device of the location or staff of the location; anyone else, including anon, is '
  'denied (42501 for anon, not_found for another tenant''s location). Implemented by 2A-JN5.';

------------------------------------------------------------------------------------------------
-- guest_act: the new actions exist and raise not_implemented
------------------------------------------------------------------------------------------------

-- redefines api.guest_act from 20261025001800_guest_rpcs.sql
create or replace function api.guest_act(p_token text, p_action api.guest_action, p_idempotency_key uuid)
returns api.visit_status
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
begin
  if p_action is null then
    raise exception 'invalid_input';
  end if;
  v := private.visit_by_token(p_token, true);

  -- One branch per api.guest_action value. Each must be safe to repeat by itself: guests have no
  -- auth.uid(), so the staff idempotency table cannot hold their keys.
  case p_action
    when 'leave' then
      if v.status = 'cancelled' then
        return private.visit_status(v);
      end if;
      if not 'leave' = any (private.guest_actions(v.status)) then
        raise exception 'illegal_transition' using detail = format('leave from %s', v.status);
      end if;
      perform private.set_actor('guest', null, 'cancel');
      update app.visits set status = 'cancelled', finished_at = now()
      where id = v.id
      returning * into v;
    when 'on_my_way', 'need_more_time', 'check_in' then
      raise exception 'not_implemented';
  end case;

  perform private.bump_queue_version(v.queue_id);
  return private.visit_status(v);
end $$;
comment on function api.guest_act(text, api.guest_action, uuid) is
  'Applies a guest action to the token''s visit and returns the new status. leave moves waiting or '
  'called to cancelled (a guest-actor cancel event); leaving again returns cancelled without '
  'error or a new event. on_my_way, need_more_time (snooze) and check_in are reserved and raise '
  'not_implemented until 2A-GST8, 2A-GST2 and 2A-CHK1. Every action is safe to repeat, so '
  'p_idempotency_key is accepted but not needed yet. Raises not_found as get_visit_status does, '
  'invalid_input without an action, illegal_transition when the action no longer applies (e.g. '
  'already served); later actions add snooze_limit_reached and check_in_not_allowed. New guest '
  'actions are new api.guest_action values. Implemented in V6 (#35).';

------------------------------------------------------------------------------------------------
-- private.join_core takes the three new join arguments (accepted and ignored for now)
------------------------------------------------------------------------------------------------

drop function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text);

-- redefines private.join_core from 20261029215747_platform_blocks.sql
create function private.join_core(
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
  prior app.visits;
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
  if not found and v_device_hash is not null then
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

  -- PLT8: a contact blocked across the platform gets the same answer as a per-client flood, so an
  -- abuser learns nothing. Staff adds are exempt (design 3.5: staff joins carry a block-list override).
  if p_source <> 'staff' and private.is_blocked(q.org_id, v_phone, v_email) then
    raise exception 'rate_limited' using detail = 'client';
  end if;

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
                          guest_token_hash, device_key_hash, source, idempotency_key)
  values (visit_id, q.org_id, q.location_id, q.id, p_service_id, v_day, q.ticket_prefix,
          v_number, q.ticket_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
          'waiting', v_sort, v_party, v_name,
          v_guest, v_contact, v_phone, v_email, v_locale,
          private.token_hash(token), v_device_hash, p_source, p_idempotency_key);
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
  'staff adds also create or link the org''s guest_contacts row and guest. p_answers (intake, '
  '2A-Q5), p_group_key (2A-J15A) and p_onsite_code (2A-JN5) are accepted and ignored until those '
  'tickets land. A kiosk device of another location gets not_found (checked via is_device).';
revoke all on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text, jsonb, uuid, text)
  from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- api.join_queue: appended defaulted parameters (extended, not a new function)
------------------------------------------------------------------------------------------------

drop function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text);
-- redefines api.join_queue from 20261029205946_join_pass.sql
create function api.join_queue(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid,
  p_device_key text default null,
  p_join_pass text default null,
  p_answers jsonb default '{}'::jsonb,
  p_group_key uuid default null,
  p_onsite_code text default null
) returns api.join_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  joined record;
  result api.join_result;
begin
  if private.device_kind() = 'kiosk' then
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'kiosk', 'device', (select auth.uid()),
      null, p_answers, p_group_key, p_onsite_code);
  else
    perform private.spend_join_pass(p_join_pass, p_queue_id, p_idempotency_key);
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'online', 'guest', null, p_device_key,
      p_answers, p_group_key, p_onsite_code);
  end if;

  select joined.token, v.display_ticket, v.status into result
  from app.visits v
  where v.id = joined.visit_id;
  return result;
end $$;
comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text) is
  'The one join interface for every source (anon guest, kiosk device; source is derived from the '
  'caller, never a parameter). Idempotent per (queue, p_idempotency_key), and per (queue, '
  'p_device_key) while that device''s visit is waiting, called or serving: a repeat returns the '
  'same visit and changes nothing, even once the queue has stopped accepting. The token comes back '
  'only to the device that joined (a replayed key needs the same p_device_key; kiosks get their '
  'own visits'' tokens), else null, as for visits older than the token secret. The token is '
  'base64url(HMAC-SHA256(Vault secret guest_token_secret, ''visit:'' || visit_id || '':'' || '
  'idempotency_key)), never stored or rotated; the visit keeps only its sha256. p_device_key is a random id the guest''s browser keeps (22 to 128 '
  'base64url characters); kiosks'' is ignored, since many guests share one. When the deployment '
  'has a Turnstile site key, an online join needs p_join_pass from api.issue_join_pass: unused '
  'and unexpired, or spent within the last day on this same queue and p_idempotency_key (a '
  'replay); a refused join '
  'leaves it unspent. Kiosks need none. Client values for '
  'priority, status, org or ticket are never accepted. Blank name, phone, email, locale or device '
  'key count as not given; party size defaults to 1. The phone and email are kept on the visit '
  'for its own messages and never linked to an existing guest. Raises captcha_required (online '
  'join without a valid pass), queue_not_accepting '
  '(paused, closed or outside hours; the reason is the DETAIL), org_suspended (the org is not '
  'active), capacity_reached, rate_limited (DETAIL client: this phone on this network; network: '
  'this network; queue: everyone, for a minute; queue_total: the queue''s online joins for the '
  'hour; device: this kiosk), not_found (unknown queue or '
  'service, or a kiosk of another location), invalid_input (bad name, phone, email, party size, '
  'locale or device key, or no key). p_answers (intake answers, 2A-Q5), p_group_key (join as '
  'a group, 2A-J15A) and p_onsite_code (the code on the display, 2A-JN5) are accepted and '
  'ignored until those tickets land; later they add party_size_out_of_range, invalid_answers, '
  'onsite_code_required, onsite_code_invalid, captcha_failed and too_many_active_visits. Later '
  'phases append parameters with defaults; never add join_* variants. Implemented in V1 (#30), '
  'device key in #474, join pass for Turnstile.';

------------------------------------------------------------------------------------------------
-- Staff and admin stubs (#88): authenticated only; the role check is the body's job
------------------------------------------------------------------------------------------------

create function api.move_visit(p_visit_id uuid, p_after_visit_id uuid, p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.move_visit(uuid, uuid, int, uuid) is
  'Moves the visit to just after p_after_visit_id in its queue (null = to the front) by taking a '
  'sort_key midpoint, and returns its row with the undo event. Staff of the location. Raises '
  'stale_visit when p_expected_version is old, illegal_transition unless the visit is waiting, '
  'not_found for unknown or foreign ids. Idempotent per key. Implemented by 2A-Q1.';

create function api.transfer_visit(p_visit_id uuid, p_to_queue_id uuid, p_to_service_id uuid, p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.transfer_visit(uuid, uuid, uuid, int, uuid) is
  'Moves a waiting or called visit to another queue of the same org (a transferred event, not a '
  'state), keeping its place by joined_at. Staff of both locations. Raises stale_visit, '
  'illegal_transition, not_found, queue_not_accepting. Idempotent per key. Implemented by 2A-Q6.';

create function api.assign_visit(p_visit_id uuid, p_counter_id uuid, p_staff_user_id uuid, p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.assign_visit(uuid, uuid, uuid, int, uuid) is
  'Assigns the visit to a counter, a staff member or both; both null unassigns. Records an assigned '
  'event. Staff of the location; the counter and member must belong to it. Raises stale_visit, '
  'not_found. Idempotent per key. Implemented by 2A-ST1.';

create function api.update_visit_notes(p_visit_id uuid, p_notes text, p_tags text[], p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.update_visit_notes(uuid, text, text[], int, uuid) is
  'Replaces the staff-only notes and tags of the visit and records a note-updated event. Staff of '
  'the location. Raises stale_visit, invalid_input (over-long notes or tags), not_found. Idempotent '
  'per key. Implemented by 2A-ST4.';

create function api.set_visit_answers(p_visit_id uuid, p_answers jsonb, p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.set_visit_answers(uuid, jsonb, int, uuid) is
  'Replaces the intake answers of the visit after validating them against the queue''s questions. '
  'Staff of the location. Raises invalid_answers, stale_visit, not_found. Idempotent per key. '
  'Implemented by 2A-Q5.';

create function api.visit_history(p_visit_id uuid)
returns setof api.visit_history_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.visit_history(uuid) is
  'The visit''s events in order with a readable actor, reason and summary, merged with its '
  'notification outcomes (never recipient values). Staff of the location. Raises not_found for '
  'unknown or foreign ids. Implemented by 2A-ST7.';

create function api.search_visits(p_location_id uuid, p_query text, p_days int default 1, p_limit int default 20)
returns setof api.visit_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.search_visits(uuid, text, int, int) is
  'Visits of the location from the last p_days service days whose ticket, name or phone ends match '
  'p_query, newest first, at most p_limit. Staff of the location. Raises invalid_input for an empty '
  'query, not_found for a foreign location. Implemented by 2A-ST7.';

create function api.find_visit_by_scan_code(p_location_id uuid, p_code text)
returns api.visit_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.find_visit_by_scan_code(uuid, text) is
  'The visit of the location that carries scan code p_code (the QR a guest shows at the door). '
  'Staff of the location. Raises not_found for an unknown code or foreign location. Implemented by '
  '2A-CHK1.';

create function api.correct_visit_times(p_visit_id uuid, p_called_at timestamptz, p_serving_at timestamptz, p_finished_at timestamptz, p_reason text, p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.correct_visit_times(uuid, timestamptz, timestamptz, timestamptz, text, int, uuid) is
  'Corrects the called, serving and finished times of a finished visit so reports stay true. '
  'Manager or above. A reason is required and recorded with the before and after times. Raises '
  'invalid_input (times out of order or no reason), stale_visit, not_found. Idempotent per key. '
  'Implemented by 2A-ST12.';

create function api.set_wait_override(p_queue_id uuid, p_minutes int, p_until timestamptz, p_idempotency_key uuid)
returns api.queue_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.set_wait_override(uuid, int, timestamptz, uuid) is
  'Replaces the ETA for the queue with p_minutes until p_until; both null clears it. Staff of the '
  'location. Raises invalid_input, not_found. Idempotent per key. Implemented by 2A-Q7.';

create function api.create_invitation(p_org_id uuid, p_email text, p_role text, p_location_ids uuid[], p_display_name text, p_idempotency_key uuid)
returns api.invitation_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.create_invitation(uuid, text, text, uuid[], text, uuid) is
  'Invites an email to the org with a role and locations. Owners may invite any role, admins '
  'manager and staff only. Returns the plaintext token once; only its sha256 is stored. Raises '
  'permission_denied, invalid_input, not_found. Idempotent per key. Implemented by 2A-TM1.';

create function api.accept_invitation(p_token text)
returns api.membership_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.accept_invitation(text) is
  'Accepts the invitation for the signed-in user whose email matches the invited one and returns '
  'the new membership. Repeating it for the same user returns the same membership. Raises not_found '
  'for an unknown, expired or revoked token or another user''s email. Implemented by 2A-TM1.';

create function api.revoke_invitation(p_invitation_id uuid, p_idempotency_key uuid)
returns api.invitation_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.revoke_invitation(uuid, uuid) is
  'Revokes an unaccepted invitation. Owners and admins of the org. Revoking again changes nothing. '
  'Raises not_found for unknown or foreign ids. Implemented by 2A-TM1.';

create function api.set_member_role(p_membership_id uuid, p_role text, p_location_ids uuid[], p_idempotency_key uuid)
returns api.membership_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.set_member_role(uuid, text, uuid[], uuid) is
  'Changes a member''s role and locations. Owners any role, admins manager and staff only; the last '
  'owner cannot be demoted. Raises permission_denied, invalid_input, not_found. Idempotent per key. '
  'Implemented by 2A-TM2.';

create function api.remove_member(p_membership_id uuid, p_reason text, p_idempotency_key uuid)
returns api.membership_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.remove_member(uuid, text, uuid) is
  'Removes a member and ends their operator sessions; the last owner cannot be removed. Owners and '
  'admins as for set_member_role. Raises permission_denied, not_found. Idempotent per key. '
  'Implemented by 2A-TM2.';

create function api.set_my_pin(p_org_id uuid, p_pin text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.set_my_pin(uuid, text) is
  'Sets or replaces the caller''s operator PIN for the org (stored hashed). Raises invalid_input for '
  'a PIN that is not 4 to 8 digits, not_a_member. Never returns the PIN. Implemented by 2A-TM4.';

create function api.switch_operator(p_location_id uuid, p_user_id uuid, p_pin text)
returns api.operator_session
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.switch_operator(uuid, uuid, text) is
  'From a paired shared device, starts an operator session for the member with this PIN and returns '
  'the token once. Raises permission_denied for a wrong PIN (rate limited), not_found. Later '
  'mutating RPCs attribute their events to the operator while the token is valid. Implemented by '
  '2A-TM4.';

create function api.end_operator_session(p_operator_token text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.end_operator_session(text) is
  'Ends the operator session for the token. Ending an ended or unknown session changes nothing. '
  'Implemented by 2A-TM4.';

create function api.list_industry_templates()
returns setof api.industry_template
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.list_industry_templates() is
  'The setup templates (barber, clinic, restaurant and so on) a new location can start from. Any '
  'signed-in member. Implemented by 2A-ORG4.';

create function api.apply_industry_template(p_location_id uuid, p_template_key text, p_idempotency_key uuid)
returns api.template_result
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.apply_industry_template(uuid, text, uuid) is
  'Creates the template''s queues, services and counters in the location. Owner or admin of the '
  'location; refuses when the location already has visits today. Raises not_found for an unknown '
  'template or foreign location, invalid_input. Idempotent per key. Implemented by 2A-ORG4.';

revoke all on function
  api.move_visit(uuid, uuid, int, uuid),
  api.transfer_visit(uuid, uuid, uuid, int, uuid),
  api.assign_visit(uuid, uuid, uuid, int, uuid),
  api.update_visit_notes(uuid, text, text[], int, uuid),
  api.set_visit_answers(uuid, jsonb, int, uuid),
  api.visit_history(uuid),
  api.search_visits(uuid, text, int, int),
  api.find_visit_by_scan_code(uuid, text),
  api.correct_visit_times(uuid, timestamptz, timestamptz, timestamptz, text, int, uuid),
  api.set_wait_override(uuid, int, timestamptz, uuid),
  api.create_invitation(uuid, text, text, uuid[], text, uuid),
  api.accept_invitation(text),
  api.revoke_invitation(uuid, uuid),
  api.set_member_role(uuid, text, uuid[], uuid),
  api.remove_member(uuid, text, uuid),
  api.set_my_pin(uuid, text),
  api.switch_operator(uuid, uuid, text),
  api.end_operator_session(text),
  api.list_industry_templates(),
  api.apply_industry_template(uuid, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  api.move_visit(uuid, uuid, int, uuid),
  api.transfer_visit(uuid, uuid, uuid, int, uuid),
  api.assign_visit(uuid, uuid, uuid, int, uuid),
  api.update_visit_notes(uuid, text, text[], int, uuid),
  api.set_visit_answers(uuid, jsonb, int, uuid),
  api.visit_history(uuid),
  api.search_visits(uuid, text, int, int),
  api.find_visit_by_scan_code(uuid, text),
  api.correct_visit_times(uuid, timestamptz, timestamptz, timestamptz, text, int, uuid),
  api.set_wait_override(uuid, int, timestamptz, uuid),
  api.create_invitation(uuid, text, text, uuid[], text, uuid),
  api.accept_invitation(text),
  api.revoke_invitation(uuid, uuid),
  api.set_member_role(uuid, text, uuid[], uuid),
  api.remove_member(uuid, text, uuid),
  api.set_my_pin(uuid, text),
  api.switch_operator(uuid, uuid, text),
  api.end_operator_session(text),
  api.list_industry_templates(),
  api.apply_industry_template(uuid, text, uuid)
to authenticated;

------------------------------------------------------------------------------------------------
-- Grants: guest functions (anon + authenticated), display code (authenticated), join_queue
------------------------------------------------------------------------------------------------

revoke all on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text)
  to anon, authenticated, service_role;

revoke all on function api.get_visit_info(text), api.get_location_wait(text), api.display_onsite_code(uuid)
  from public, anon, authenticated, service_role;
grant execute on function api.get_visit_info(text), api.get_location_wait(text)
  to anon, authenticated, service_role;
grant execute on function api.display_onsite_code(uuid) to authenticated;

------------------------------------------------------------------------------------------------
-- Non-transition visit events (#88)
------------------------------------------------------------------------------------------------

-- Transferred, snoozed, assigned and note-updated are events, not states (technical-design.md 4.1).
-- The guard accepted a free-form action only as 'transfer'; any action that is not a visit_action
-- name is now an event type, allowed while the status stays put.
-- redefines private.guard_visit from 20261025003620_support_grants.sql
create or replace function private.guard_visit() returns trigger
language plpgsql set search_path = '' as $$
declare
  act text := private.current_action();
  target api.visit_state;
  blocked text;
begin
  if nullif(current_setting('app.actor_kind', true), '') is null then
    raise exception 'missing_actor_context'
      using hint = 'Visits change only through api.* functions, which call private.set_actor().';
  end if;

  -- Staff and devices need an active org, and staff need membership or an 'act' grant. Guests and
  -- the system are not checked here.
  if current_setting('app.actor_kind') in ('staff', 'device') then
    blocked := private.write_blocked_reason(new.org_id, current_setting('app.actor_kind'),
                                            nullif(current_setting('app.actor_id', true), '')::uuid);
    if blocked is not null then
      raise exception '%', blocked using errcode = '42501';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('waiting', 'expected') then
      raise exception 'illegal_transition' using detail = format('a visit cannot start as %s', new.status);
    end if;
    new.version := 0;
    return new;
  end if;

  if new.org_id is distinct from old.org_id or new.id is distinct from old.id
     or new.guest_token_hash is distinct from old.guest_token_hash then
    raise exception 'immutable_column' using errcode = '42501';
  end if;

  -- Undo is validated by api.undo_event (V3), which restores the previous status.
  if act = 'undo' then
    new.version := old.version + 1;
    return new;
  end if;

  if act is not null and act = any (enum_range(null::api.visit_action)::text[]) then
    select t.to_status into target
    from app.visit_transitions t
    where t.from_status = old.status and t.action::text = act;
    if target is null or target <> new.status then
      raise exception 'illegal_transition'
        using detail = format('%s -> %s via %s', old.status, new.status, act);
    end if;
  elsif new.status is distinct from old.status then
    raise exception 'illegal_transition'
      using detail = format('%s -> %s without an action', old.status, new.status);
  end if;

  new.version := old.version + 1;
  return new;
end $$;

create function private.record_visit_event(p_visit_id uuid, p_type text, p_payload jsonb)
returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_queue uuid;
begin
  if nullif(btrim(p_type), '') is null or p_type in ('joined', 'updated', 'undo')
     or p_type = any (enum_range(null::api.visit_action)::text[]) then
    raise exception 'invalid_input';
  end if;
  -- Keeps the caller's actor kind, id and reason (private.set_actor); only the event type and
  -- payload change. The guard bumps visits.version and the event trigger writes the one event.
  perform set_config('app.action', p_type, true),
          set_config('app.event_payload', coalesce(p_payload, '{}')::text, true);
  update app.visits set version = version where id = p_visit_id returning queue_id into v_queue;
  if not found then
    raise exception 'not_found';
  end if;
  perform private.bump_queue_version(v_queue);
end $$;
comment on function private.record_visit_event(uuid, text, jsonb) is
  'Records an event that is not a status transition (transferred, snoozed, assigned, note_updated, '
  'any p_type that is not a visit_action name) with the actor context the caller set through '
  'private.set_actor, bumps visits.version and queues.version so realtime signals fire, and '
  'changes nothing else. Call set_actor first; it raises missing_actor_context without one. '
  'Raises invalid_input for a blank type or one the state machine owns, not_found for an '
  'unknown visit. Not exposed.';
revoke all on function private.record_visit_event(uuid, text, jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';

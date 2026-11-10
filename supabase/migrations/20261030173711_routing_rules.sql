-- 2B-Q4 (#229): routing rules pick the queue at join (Q-11).
--
-- redefines private.join_core from 20261030172107_priority_rules.sql
-- redefines api.join_queue from 20261030162713_api_contracts_2b.sql

alter table app.services add unique (org_id, location_id, id);

create table app.routing_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  rank int not null default 0,
  service_id uuid,
  field_id uuid,
  answer_value text check (length(answer_value) <= 200),
  target_queue_id uuid not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  foreign key (org_id, location_id, target_queue_id) references app.queues (org_id, location_id, id) on delete cascade,
  foreign key (org_id, location_id, service_id) references app.services (org_id, location_id, id) on delete cascade,
  foreign key (org_id, field_id) references app.intake_fields (org_id, id) on delete cascade,
  constraint routing_rules_answer check ((field_id is null) = (answer_value is null))
);
create index routing_rules_location_idx on app.routing_rules (location_id, rank);

/** An answer condition names a question of the target queue, whose form the guest fills in. */
create function private.check_routing_rule() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.field_id is not null and not exists (
    select 1 from app.intake_fields f where f.id = new.field_id and f.queue_id = new.target_queue_id) then
    raise exception 'invalid_input' using detail = 'field';
  end if;
  return new;
end $$;
comment on function private.check_routing_rule() is
  'BEFORE trigger on app.routing_rules: an intake_answer condition must be a question of the target queue.';
create trigger check_routing_rule before insert or update on app.routing_rules
  for each row execute function private.check_routing_rule();
create trigger forbid_org_change before update on app.routing_rules
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.routing_rules
  for each row execute function private.audit_row();

alter table app.routing_rules enable row level security;
revoke delete, truncate on app.routing_rules from authenticated;
create policy routing_rules_select on app.routing_rules for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
create policy routing_rules_insert on app.routing_rules for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy routing_rules_update on app.routing_rules for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
grant select, insert, update on app.routing_rules to authenticated;

/**
 * The queue a location-level join goes to: the lowest-rank active rule whose service (if any) is
 * p_service_id and whose answer (if any) matches p_answers, aimed at a queue that is not archived.
 * Both are null when none matches; the caller raises no_route once its gates (CAPTCHA pass) have run. Q-17 is not checked here: join_core still decides.
 */
create function private.route_join(p_location_id uuid, p_service_id uuid, p_answers jsonb, out queue_id uuid, out rule_id uuid)
language plpgsql stable set search_path = '' as $$
begin
  select r.target_queue_id, r.id into queue_id, rule_id
  from app.routing_rules r
  join app.queues tq on tq.id = r.target_queue_id and tq.archived_at is null
  left join app.intake_fields f on f.id = r.field_id and f.active
  where r.location_id = p_location_id and r.active
    and (r.service_id is null or r.service_id = p_service_id)
    and (r.field_id is null or (jsonb_typeof(p_answers) = 'object' and p_answers ->> f.key = r.answer_value))
  order by r.rank, r.id
  limit 1;
end $$;
comment on function private.route_join(uuid, uuid, jsonb) is
  'The target queue and rule for a join to a location, nulls when no rule matches. Not exposed.';
revoke all on function private.route_join(uuid, uuid, jsonb) from public, anon, authenticated;

drop function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text, jsonb, uuid, text);
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
  p_routing_rule_id uuid default null,
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
  v_prefix text;
  v_class uuid;
  v_rule uuid;
  v_offset int;
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
  v_prefix := q.ticket_prefix;
  if p_service_id is not null then
    -- 2A-Q4: a service's own prefix overrides the queue's; numbers run per prefix.
    select coalesce(s.ticket_prefix, q.ticket_prefix) into v_prefix
    from app.services s where s.id = p_service_id and s.queue_id = q.id and s.active;
    if not found then
      raise exception 'not_found';
    end if;
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

  -- 2A-Q5: party size is a queue policy. Off: always one person, whatever the client sent. On:
  -- inside the queue's bounds, for every source.
  if q.party_size_enabled then
    if v_party not between q.party_size_min and q.party_size_max then
      raise exception 'party_size_out_of_range';
    end if;
  else
    v_party := 1;
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
  v_number := private.next_ticket(q.id, v_prefix, v_day);
  -- Spaced so a later reorder can take a midpoint. Called guests count: requeue keeps their place.
  visit_id := gen_random_uuid();
  -- 2B-Q2: the queue's priority rules run on server data only (source, validated answers); a class
  -- files the visit by arrival time minus its offset, no class goes behind everyone.
  select m.class_id, m.rule_id into v_class, v_rule from private.match_priority_rule(q.id, p_source, v_answers) m;
  if v_class is not null then
    -- Set first: a renumbering inside priority_sort_key is recorded under this actor.
    perform private.set_actor(p_actor_kind, p_actor_id, null, null, jsonb_build_object('source', p_source));
    select pc.offset_minutes into v_offset from app.priority_classes pc where pc.id = v_class;
    v_sort := private.priority_sort_key(q.id, v_day, visit_id, now(), v_offset);
  else
    select coalesce(max(v.sort_key), 0) + 1024 into v_sort
    from app.visits v
    where v.queue_id = q.id and v.status in ('waiting', 'called');
  end if;
  token := private.visit_token(visit_id, p_idempotency_key);

  perform private.set_actor(p_actor_kind, p_actor_id, null, null,
    jsonb_build_object('source', p_source)
      || case when v_rule is null then '{}'::jsonb else jsonb_build_object('priority_rule_id', v_rule) end
      || case when p_routing_rule_id is null then '{}'::jsonb else jsonb_build_object('routing_rule_id', p_routing_rule_id) end);
  insert into app.visits (id, org_id, location_id, queue_id, service_id, service_day, ticket_prefix,
                          ticket_number, display_ticket, status, sort_key, party_size, guest_name,
                          guest_id, contact_id, guest_phone_e164, guest_email, locale,
                          guest_token_hash, device_key_hash, source, idempotency_key, group_key,
                          priority_class_id)
  values (visit_id, q.org_id, q.location_id, q.id, p_service_id, v_day, v_prefix,
          v_number, v_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
          'waiting', v_sort, v_party, v_name,
          v_guest, v_contact, v_phone, v_email, v_locale,
          private.token_hash(token), v_device_hash, p_source, p_idempotency_key, p_group_key,
          v_class);
  if v_answers <> '{}' then
    insert into app.visit_answers (org_id, location_id, visit_id, answers)
    values (q.org_id, q.location_id, visit_id, v_answers);
  end if;
  perform private.bump_queue_version(q.id);
end $$;

comment on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text, jsonb, uuid, text, uuid) is
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
  'staff adds also create or link the org''s guest_contacts row and guest. a service''s ticket_prefix, when set, replaces the queue''s on the visit and its ticket number runs per prefix. Party size follows the queue policy: with it off the visit stores 1 whatever p_party_size says, with it on a size outside party_size_min..party_size_max raises party_size_out_of_range (all sources; 1 to 50 is still checked first as invalid_input). p_answers (intake) is validated against the queue''s active fields by private.validate_answers '
  '(invalid_answers with the failing key as DETAIL; staff-only fields are refused for guests; a staff add skips the required check) before a rate slot is taken, and stored in app.visit_answers. p_group_key links the visits of one group on the visit (a group join skips the device-key replay, so a parent can join several people; only the idempotency key replays it). A non-staff join raises too_many_active_visits when the phone or, online, the device already holds queues.max_active_per_contact waiting, called or serving visits on the queue. When the '
  'location requires an on-site code, an online join without the displayed code (current or previous window) '
  'raises onsite_code_required or onsite_code_invalid, after the accepting predicate and before rate limits; kiosk and staff joins are exempt. A kiosk device of another location gets not_found (checked via is_device). Next, the org''s block list (private.is_org_blocked): non-staff joins get queue_not_accepting with DETAIL closed, staff adds get guest_blocked. Priority rules (private.match_priority_rule) run on the source and the validated answers only, never on a client priority field: the lowest-rank active rule that matches gives the visit its class and files it by arrival time minus the class offset; the joined event names the rule (priority_rule_id). '
  'p_routing_rule_id (2B-Q4) is the routing rule that picked the queue; it is only recorded in the joined event (routing_rule_id).';

revoke all on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text, jsonb, uuid, text, uuid)
  from public, anon, authenticated;

create or replace function api.join_queue(
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
  p_onsite_code text default null,
  p_location_id uuid default null,
  p_arrive_after timestamptz default null
) returns api.join_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  joined record;
  result api.join_result;
  v_queue uuid := p_queue_id;
  v_rule uuid;
  v_service uuid := p_service_id;
  v_routed boolean := p_queue_id is null and p_location_id is not null;
begin
  -- 2B-Q4: a location-level join names no queue; the routing rules pick it, server side.
  if v_routed then
    select r.queue_id, r.rule_id into v_queue, v_rule from private.route_join(p_location_id, p_service_id, p_answers) r;
    -- A service of another queue stays unrecorded rather than failing the routed join.
    if not exists (select 1 from app.services s where s.id = p_service_id and s.queue_id = v_queue) then
      v_service := null;
    end if;
  end if;
  if private.device_kind() = 'kiosk' then
    if v_routed and v_queue is null then
      raise exception 'no_route';
    end if;
    select * into joined from private.join_core(v_queue, v_service, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'kiosk', 'device', (select auth.uid()),
      null, p_answers, p_group_key, p_onsite_code, v_rule);
  else
    -- 2A-JN4 (#114): once the deployment turned the direct path off, an anonymous caller has to
    -- come through the public-join Edge Function (service role), which checks the CAPTCHA and
    -- the per-IP limits first. A throwaway signed-up account is no better than anon, so every
    -- caller but the service role is refused here; kiosks took the branch above.
    if (select auth.role()) is distinct from 'service_role'
       and not (select s.anon_join_enabled from private.deployment_settings s) then
      raise exception 'captcha_required' using detail = 'public_join';
    end if;
    -- The public-join Edge Function (service role) has already verified the CAPTCHA with its own
    -- provider (2A-JN2); everyone else needs a Turnstile pass when the deployment has a site key.
    if (select auth.role()) is distinct from 'service_role' then
      perform private.spend_join_pass(p_join_pass, v_queue, p_idempotency_key);
    end if;
    -- After the pass, so an unauthenticated caller learns nothing about the rules without one.
    if v_routed and v_queue is null then
      raise exception 'no_route';
    end if;
    select * into joined from private.join_core(v_queue, v_service, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'online', 'guest', null, p_device_key,
      p_answers, p_group_key, p_onsite_code, v_rule);
  end if;

  select joined.token, v.display_ticket, v.status into result
  from app.visits v
  where v.id = joined.visit_id;
  return result;
end $$;

comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text, uuid, timestamptz) is
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
  'leaves it unspent. Kiosks need none, and neither does the service role (the public-join Edge Function, which verifies its CAPTCHA before calling). Client values for '
  'priority, status, org or ticket are never accepted. Blank name, phone, email, locale or device '
  'key count as not given; party size defaults to 1. The phone and email are kept on the visit '
  'for its own messages and never linked to an existing guest. Raises captcha_required (online '
  'join without a valid pass, or DETAIL public_join: any caller but a kiosk or the service role while deployment_settings.anon_join_enabled is false), queue_not_accepting '
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
  'device key in #474, join pass for Turnstile. p_location_id (2B-Q4): with p_queue_id null the '
  'location''s routing rules pick the queue from p_service_id and p_answers, then the normal join runs '
  '(accepting predicate, pass, limits); no match raises no_route and creates nothing; p_queue_id wins when both '
  'are given. p_arrive_after (join for later, 2B-J3) is accepted and ignored until that ticket lands, '
  'then adds already_in_queue (2B-J1) and the scheduling errors.';


notify pgrst, 'reload schema';

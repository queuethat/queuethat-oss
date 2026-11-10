-- 2B-J1 (#239): single active visit across queues and locations (J-16), and the join restriction hook.
--
-- redefines private.join_core from 20261030173711_routing_rules.sql

create type app.single_active_scope as enum ('off', 'location', 'org');
grant usage on type app.single_active_scope to authenticated, service_role;

alter table app.organizations add column single_active_visit app.single_active_scope not null default 'off';
comment on column app.organizations.single_active_visit is
  'J-16: off, or one active visit per contact or device within a location or the whole org.';
alter table app.visits add column device_ref_hash bytea;
create index visits_device_ref_idx on app.visits (org_id, device_ref_hash) where device_ref_hash is not null;

/** The join device key as one org sees it: the same device has the same hash on every queue of the org, unlinkable across orgs. */
create function private.device_ref_hash(p_org_id uuid, p_device_key text) returns bytea
language sql stable set search_path = '' as $$
  select extensions.hmac(convert_to('deviceref:' || p_org_id::text || ':' || p_device_key, 'UTF8'),
                         (select s.client_key_secret from private.deployment_settings s), 'sha256')
  where p_device_key is not null
$$;
comment on function private.device_ref_hash(uuid, text) is
  'HMAC-SHA256 of an org id and a join device key, stored in visits.device_ref_hash. Null for a null key.';
revoke all on function private.device_ref_hash(uuid, text) from public, anon, authenticated;

/**
 * The oldest waiting, called or serving visit of today in the scope (org, or one location) held by
 * this phone, email or device, leaving out p_except_queue_id; null when none. Org-bound, so
 * nothing matches across tenants.
 */
create function private.find_active_visit(
  p_org_id uuid, p_location_id uuid, p_phone text, p_email text, p_device_ref_hash bytea, p_except_queue_id uuid default null
) returns uuid
language sql stable set search_path = '' as $$
  select v.id
  from app.visits v
  where v.org_id = p_org_id and (p_location_id is null or v.location_id = p_location_id)
    and v.status in ('waiting', 'called', 'serving')
    and v.service_day = private.service_day(v.location_id)
    and (p_except_queue_id is null or v.queue_id <> p_except_queue_id)
    and ((p_phone is not null and v.guest_phone_e164 = p_phone)
         or (p_email is not null and private.canonical_email(v.guest_email) = private.canonical_email(p_email))
         or (p_device_ref_hash is not null and v.device_ref_hash = p_device_ref_hash))
  order by v.joined_at, v.id
  limit 1
$$;
comment on function private.find_active_visit(uuid, uuid, text, text, bytea, uuid) is
  'The id of an active visit of this phone, email or device in the org (or one location) today. Not exposed.';
revoke all on function private.find_active_visit(uuid, uuid, text, text, bytea, uuid) from public, anon, authenticated;

/** Hook for per-queue join restrictions (on-site, geofence); a no-op here. A ticket replaces the body and raises to refuse. */
create function private.check_join_restriction(p_queue_id uuid, p_source text, p_phone text, p_email text, p_device_key text) returns void
language plpgsql stable set search_path = '' as $$
begin
  null;
end $$;
comment on function private.check_join_restriction(uuid, text, text, text, text) is
  'Called by private.join_core after the block lists and before rate limits; raise to refuse the join. A no-op until a ticket defines a restriction. Not exposed.';
revoke all on function private.check_join_restriction(uuid, text, text, text, text) from public, anon, authenticated;

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
  v_ref bytea;
  v_other uuid;
  v_scope app.single_active_scope;
  v_warn boolean := false;
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

  -- 2B-W2 hook: a per-queue restriction (on-site, geofence) may refuse the join here; a no-op until
  -- a ticket replaces private.check_join_restriction.
  perform private.check_join_restriction(q.id, p_source, v_phone, v_email, v_device);

  -- 2B-J1 (J-16): with the org's rule on, one contact or device holds one active visit in the scope.
  -- A queue that allows several per contact (J-15) keeps its own visits out of the match.
  v_ref := private.device_ref_hash(q.org_id, v_device);
  select o.single_active_visit into v_scope from app.organizations o where o.id = q.org_id;
  if v_scope <> 'off' then
    v_other := private.find_active_visit(q.org_id, case when v_scope = 'location' then q.location_id end,
                                         v_phone, v_email, v_ref,
                                         case when q.max_active_per_contact > 1 then q.id end);
    if v_other is not null then
      if p_source = 'staff' then
        v_warn := true;
      else
        -- Only the device that holds the visit learns which queue it is in; a typed phone number
        -- is not proof of who is asking.
        raise exception 'already_in_queue' using detail = coalesce((
          select q2.name from app.visits v2 join app.queues q2 on q2.id = v2.queue_id
          where v2.id = v_other and v_ref is not null and v2.device_ref_hash = v_ref), 'contact');
      end if;
    end if;
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
      || case when p_routing_rule_id is null then '{}'::jsonb else jsonb_build_object('routing_rule_id', p_routing_rule_id) end
      || case when v_warn then jsonb_build_object('warning', 'already_in_queue', 'other_visit_id', v_other) else '{}'::jsonb end);
  insert into app.visits (id, org_id, location_id, queue_id, service_id, service_day, ticket_prefix,
                          ticket_number, display_ticket, status, sort_key, party_size, guest_name,
                          guest_id, contact_id, guest_phone_e164, guest_email, locale,
                          guest_token_hash, device_key_hash, source, idempotency_key, group_key,
                          priority_class_id, device_ref_hash)
  values (visit_id, q.org_id, q.location_id, q.id, p_service_id, v_day, v_prefix,
          v_number, v_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
          'waiting', v_sort, v_party, v_name,
          v_guest, v_contact, v_phone, v_email, v_locale,
          private.token_hash(token), v_device_hash, p_source, p_idempotency_key, p_group_key,
          v_class, v_ref);
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
  'p_routing_rule_id (2B-Q4) is the routing rule that picked the queue; it is only recorded in the joined event (routing_rule_id). With the org''s single_active_visit rule on (location or org), a non-staff join whose phone, email or device already holds a waiting, called or serving visit in scope raises already_in_queue (DETAIL: the other queue''s name when the same device holds it, else contact); staff adds go through and the joined event carries warning already_in_queue. private.check_join_restriction is a hook for per-queue restrictions, called after the block lists.';

notify pgrst, 'reload schema';

-- 2B-J3 (#241): join for later today (J-13) and the activation tick.
--
-- redefines private.join_core from 20261030175005_single_active_visit.sql
-- redefines api.join_queue from 20261030173711_routing_rules.sql
-- redefines private.visit_status from 20261030175652_visit_chat.sql
-- redefines private.find_active_visit from 20261030175005_single_active_visit.sql

alter table app.queues
  add column join_later_enabled boolean not null default false,
  add column join_later_max_hours int not null default 4 check (join_later_max_hours between 1 and 12);
alter table app.visits add column arrive_after timestamptz;
create index visits_arrive_after_idx on app.visits (arrive_after) where status = 'expected' and arrive_after is not null;

alter type api.visit_status add attribute arrive_after timestamptz;

drop function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text, jsonb, uuid, text, uuid);
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
  p_arrive_after timestamptz default null,
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

  -- 2B-J3 (J-13): a place for later today. Only a queue that offers it, for a time that is still ahead,
  -- inside the max hours, on this service day and while the location is open.
  if p_arrive_after is not null and (
       not q.join_later_enabled
       or p_arrive_after <= now() + interval '1 minute'
       or p_arrive_after > now() + make_interval(hours => q.join_later_max_hours)
       or private.service_day(q.location_id, p_arrive_after) <> private.service_day(q.location_id)
       or not private.location_open_at(q.location_id, p_arrive_after)) then
    raise exception 'invalid_arrive_after';
  end if;
  -- Reserved places count toward capacity, or they could all activate past it.
  if p_arrive_after is not null and q.capacity is not null and (
       select count(*) from app.visits v
       where v.queue_id = q.id and (v.status = 'waiting' or (v.status = 'expected' and v.arrive_after is not null))
     ) >= q.capacity then
    raise exception 'capacity_reached';
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
    where v.queue_id = q.id
      and (v.status in ('waiting', 'called', 'serving') or (v.status = 'expected' and v.arrive_after is not null))
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
                          priority_class_id, device_ref_hash, arrive_after)
  values (visit_id, q.org_id, q.location_id, q.id, p_service_id, v_day, v_prefix,
          v_number, v_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
          (case when p_arrive_after is null then 'waiting' else 'expected' end)::api.visit_state, v_sort, v_party, v_name,
          v_guest, v_contact, v_phone, v_email, v_locale,
          private.token_hash(token), v_device_hash, p_source, p_idempotency_key, p_group_key,
          v_class, v_ref, p_arrive_after);
  if v_answers <> '{}' then
    insert into app.visit_answers (org_id, location_id, visit_id, answers)
    values (q.org_id, q.location_id, visit_id, v_answers);
  end if;
  perform private.bump_queue_version(q.id);
end $$;

comment on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text, jsonb, uuid, text, uuid, timestamptz) is
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
  'p_routing_rule_id (2B-Q4) is the routing rule that picked the queue; it is only recorded in the joined event (routing_rule_id). With the org''s single_active_visit rule on (location or org), a non-staff join whose phone, email or device already holds a waiting, called or serving visit in scope raises already_in_queue (DETAIL: the other queue''s name when the same device holds it, else contact); staff adds go through and the joined event carries warning already_in_queue. private.check_join_restriction is a hook for per-queue restrictions, called after the block lists. p_arrive_after (2B-J3) reserves a place for later today: the queue must offer it (join_later_enabled) and the time must be ahead, within join_later_max_hours, on today''s service day and inside opening hours, else invalid_arrive_after; the visit starts expected (with its ticket and token) and ops.activate_later_tick makes it waiting at that time.';

revoke all on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text, jsonb, uuid, text, uuid, timestamptz)
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
      null, p_answers, p_group_key, p_onsite_code, v_rule, p_arrive_after);
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
      p_answers, p_group_key, p_onsite_code, v_rule, p_arrive_after);
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
  'are given. p_arrive_after (2B-J3, join for later): '
  'with the queue''s join_later_enabled, reserves a place at that time today (within join_later_max_hours and opening '
  'hours); the visit is expected until then and the token works at once. Raises invalid_arrive_after (queue does '
  'not offer it, or the time is past, too far, tomorrow or outside hours), already_in_queue (2B-J1).';



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
          where m.visit_id = p_visit.id and m.sender = 'staff' and m.read_at is null),
         p_visit.arrive_after
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

------------------------------------------------------------------------------------------------
-- The activation tick
------------------------------------------------------------------------------------------------

/**
 * Turns every expected later-join visit whose time has come into a waiting one, filed by the time
 * it said it would arrive (guests who joined before that time stay ahead, those after stay
 * behind), with its ETA quoted then. A closed queue still activates it: the place was promised.
 * Returns how many it activated; running it again finds nothing more. Not callable via the API.
 */
create function ops.activate_later_tick() returns int
language plpgsql volatile set search_path = '' as $$
declare
  qid uuid;
  v app.visits;
  v_offset int;
  v_sort bigint;
  n int := 0;
begin
  -- Queue lock first, as private.join_core takes it, then the visits: a renumbering inside
  -- priority_sort_key touches other visits of the queue.
  for qid in
    select distinct queue_id from app.visits
    where status = 'expected' and arrive_after is not null and arrive_after <= now()
  loop
    perform 1 from app.queues where id = qid for update;
    for v in
      select * from app.visits
      where queue_id = qid and status = 'expected' and arrive_after is not null and arrive_after <= now()
      order by arrive_after, id
      for update skip locked
    loop
      select coalesce((select pc.offset_minutes from app.priority_classes pc where pc.id = v.priority_class_id), 0)
        into v_offset;
      v_sort := private.priority_sort_key(v.queue_id, v.service_day, v.id, v.arrive_after, v_offset);
      -- Set after the placement: a renumbering there records its own action.
      perform private.set_actor('system', null, 'check_in', null, jsonb_build_object('later', true));
      -- Joined at its arrival time from here on, so waiting time and later fairness count from then.
      update app.visits
      set status = 'waiting', sort_key = v_sort, joined_at = v.arrive_after,
          eta_quoted_low = (select e.eta_low from private.eta_at(v.queue_id, v_sort) e),
          eta_quoted_high = (select e.eta_high from private.eta_at(v.queue_id, v_sort) e)
      where id = v.id;
      perform private.bump_queue_version(v.queue_id);
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
comment on function ops.activate_later_tick() is
  'Activates expected later-join visits whose arrive_after has passed (waiting, filed by that time, ETA quoted); idempotent. Run every minute by pg_cron. Not callable via the API.';
revoke all on function ops.activate_later_tick() from public, anon, authenticated;

select cron.schedule('activate-later-visits', '* * * * *', 'select ops.activate_later_tick()');

-- redefines private.find_active_visit from 20261030175005_single_active_visit.sql
create or replace function private.find_active_visit(
  p_org_id uuid, p_location_id uuid, p_phone text, p_email text, p_device_ref_hash bytea, p_except_queue_id uuid default null
) returns uuid
language sql stable set search_path = '' as $$
  select v.id
  from app.visits v
  where v.org_id = p_org_id and (p_location_id is null or v.location_id = p_location_id)
    and (v.status in ('waiting', 'called', 'serving') or (v.status = 'expected' and v.arrive_after is not null))
    and v.service_day = private.service_day(v.location_id)
    and (p_except_queue_id is null or v.queue_id <> p_except_queue_id)
    and ((p_phone is not null and v.guest_phone_e164 = p_phone)
         or (p_email is not null and private.canonical_email(v.guest_email) = private.canonical_email(p_email))
         or (p_device_ref_hash is not null and v.device_ref_hash = p_device_ref_hash))
  order by v.joined_at, v.id
  limit 1
$$;

notify pgrst, 'reload schema';

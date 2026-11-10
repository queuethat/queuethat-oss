-- 2B-Q10 (#235): per-queue join restriction (none, on-site code, geofence).
-- The on-site code itself (2A-JN5) is unchanged: a queue set to onsite_code requires it even when
-- the location does not. The geofence reads coordinates the public-join Edge Function forwards in
-- x-qm-geo ("lat,lng,accuracy_m"), believed only for the service role. Coordinates come from the
-- guest's browser, so a geofence is a soft check (a determined guest can fake it); the on-site code
-- is the real control. Staff, kiosk and API joins are exempt.

create type app.join_restriction as enum ('none', 'onsite_code', 'geofence');

alter table app.queues
  add column join_restriction app.join_restriction not null default 'none';
comment on column app.queues.join_restriction is
  'Extra proof a public (online) join must carry: onsite_code (the code on the display) or geofence (a position within the location''s radius). Staff and kiosk joins are exempt.';

alter table app.locations
  add column lat double precision check (lat between -90 and 90),
  add column lng double precision check (lng between -180 and 180),
  add column geofence_m int not null default 150 check (geofence_m between 10 and 5000),
  add constraint locations_position_both check ((lat is null) = (lng is null));
comment on column app.locations.lat is 'Latitude of the premises, for geofenced queues. Null until set.';
comment on column app.locations.geofence_m is 'Radius in metres around lat/lng that a geofenced queue accepts, before the browser''s own accuracy allowance (at most 100 m).';

-- A geofenced queue needs premises coordinates, or every online join would be refused.
create function private.guard_geofence() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'queues' then
    if new.join_restriction = 'geofence'
       and exists (select 1 from app.locations l where l.id = new.location_id and l.lat is null) then
      raise exception 'invalid_input' using detail = 'geofence_needs_position';
    end if;
  elsif new.lat is null and exists (
    select 1 from app.queues q where q.location_id = new.id and q.join_restriction = 'geofence') then
    raise exception 'invalid_input' using detail = 'geofence_needs_position';
  end if;
  return new;
end $$;
revoke all on function private.guard_geofence() from public, anon, authenticated;
create trigger guard_geofence before insert or update of join_restriction, location_id on app.queues
  for each row execute function private.guard_geofence();
create trigger guard_geofence before update of lat on app.locations
  for each row execute function private.guard_geofence();

-- redefines private.check_join_restriction from 20261030175005_single_active_visit.sql
create or replace function private.check_join_restriction(p_queue_id uuid, p_source text, p_phone text, p_email text, p_device_key text) returns void
language plpgsql stable set search_path = '' as $$
declare
  q app.queues;
  l app.locations;
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}');
  raw text := case when (select auth.role()) = 'service_role' then headers ->> 'x-qm-geo' end;
  parts text[];
  v_lat float8;
  v_lng float8;
  v_acc float8;
  v_dist float8;
begin
  if p_source <> 'online' then
    return;
  end if;
  select * into q from app.queues where id = p_queue_id;
  if not found or q.join_restriction is distinct from 'geofence' then
    return;
  end if;
  select * into l from app.locations where id = q.location_id;
  -- A geofence without premises coordinates cannot be met; the admin page refuses to save one.
  if l.lat is null or raw is null then
    raise exception 'onsite_required';
  end if;
  begin
    parts := string_to_array(raw, ',');
    v_lat := parts[1]::float8;
    v_lng := parts[2]::float8;
    v_acc := coalesce(parts[3]::float8, 0);
  exception when others then
    raise exception 'onsite_required';
  end;
  -- NaN and out-of-range values fail the between tests too.
  if not (v_lat between -90 and 90 and v_lng between -180 and 180 and v_acc between 0 and 100000) then
    raise exception 'onsite_required';
  end if;
  -- Haversine on a 6371 km sphere; the browser's accuracy radius counts in the guest's favour, capped at 100 m.
  v_dist := 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(v_lat - l.lat) / 2), 2)
    + cos(radians(l.lat)) * cos(radians(v_lat)) * power(sin(radians(v_lng - l.lng) / 2), 2))));
  if v_dist - least(v_acc, 100) > l.geofence_m then
    raise exception 'onsite_required';
  end if;
end $$;
comment on function private.check_join_restriction(uuid, text, text, text, text) is
  'Called by private.join_core after the block lists and before rate limits. For an online join to a geofence queue, raises onsite_required unless the service role forwarded x-qm-geo ("lat,lng,accuracy_m") within the location''s radius (plus up to 100 m of accuracy). A no-op for every other queue and for staff and kiosk joins. Not exposed.';

-- redefines private.join_core from 20261030180718_join_later.sql (queue-level onsite_code restriction)
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
    if l.onsite_code_required or q.join_restriction = 'onsite_code' then
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

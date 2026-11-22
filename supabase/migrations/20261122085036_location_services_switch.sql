-- Location-level services, step 2 of 3 (switch; queuethat-oss #75).
--
-- After this migration a service belongs to a location and a queue offers it through
-- app.queue_services (added in 20261122080857_queue_services.sql). services.queue_id stays, nullable,
-- so older web bundles keep working for one release; the next migration drops it.
--
-- * services.queue_id becomes optional; services.merged_into_id records a retired duplicate.
-- * visits point at (org, location, service) instead of (org, queue, service). "The queue offers
--   the service" is checked in join_core, not by a foreign key.
-- * join, ETA, the public location read, transfers, booking and templates read queue_services.
-- * An appointment lands in the service's first queue (private.service_queue: queue sort order).
-- * private.service_merge_plan() is the dry-run report and private.merge_identical_services() the
--   merge for existing locations. Neither runs here: an operator reads the plan first, then merges.
--   Visits and appointments are never rewritten (I-1); a retired copy keeps its history.

alter table app.services alter column queue_id drop not null;
alter table app.services add column merged_into_id uuid references app.services (id);
comment on column app.services.merged_into_id is
  'Set when this service was an identical copy retired by private.merge_identical_services; points at the survivor. Reports roll the copy into it.';
comment on column app.queue_services.sort_order is
  'Position of the service in the queue''s list. (Which queue an appointment lands in is decided by the queue''s own sort order: private.service_queue.)';

-- The visit's service must belong to the visit's location; that the queue offers it is checked by join_core.
alter table app.visits drop constraint visits_org_id_queue_id_service_id_fkey;
alter table app.visits add foreign key (org_id, location_id, service_id)
  references app.services (org_id, location_id, id) not valid;
alter table app.visits validate constraint visits_org_id_location_id_service_id_fkey;

create function private.queue_offers_service(p_queue_id uuid, p_service_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from app.queue_services qs where qs.queue_id = p_queue_id and qs.service_id = p_service_id)
$$;
comment on function private.queue_offers_service(uuid, uuid) is
  'True when the queue offers the service. Does not look at services.active; callers add that.';

create function private.service_queue(p_service_id uuid) returns uuid
language sql stable set search_path = '' as $$
  select qs.queue_id
  from app.queue_services qs
  join app.queues q on q.id = qs.queue_id
  where qs.service_id = p_service_id
  order by (q.archived_at is not null), q.sort_order, q.created_at, q.id
  limit 1
$$;
comment on function private.service_queue(uuid) is
  'The queue an appointment for the service lands in: the first queue that offers it by queue sort '
  'order (archived queues last). Null when no queue offers the service. v1 rule; the guest never picks a queue.';

-- Finds the location's service of that name or creates it, with the template's booking policy.
create function private.template_service(p_loc app.locations, p_def jsonb, p_tpl jsonb, p_mode text,
                                         out o_service_id uuid, out o_created boolean)
language plpgsql set search_path = '' as $$
declare
  v_name text := private.catalog_text(p_def -> 'name');
begin
  select x.id into o_service_id from app.services x
  where x.location_id = p_loc.id and x.active and x.merged_into_id is null and x.name = v_name
  order by x.created_at, x.id limit 1;
  o_created := o_service_id is null;
  if not o_created then return; end if;
  insert into app.services (org_id, location_id, name, expected_minutes, ticket_prefix)
  values (p_loc.org_id, p_loc.id, v_name, (p_def ->> 'minutes')::int, p_def ->> 'prefix')
  returning id into o_service_id;
  if p_mode in ('booking', 'both') and jsonb_typeof(p_tpl -> 'booking') = 'object'
     and p_def -> 'bookable' is distinct from 'false'::jsonb then
    insert into app.booking_policies (org_id, location_id, service_id, bookable, slot_minutes,
                                      buffer_after_minutes, min_notice_minutes, max_days_ahead)
    values (p_loc.org_id, p_loc.id, o_service_id, true,
            coalesce((p_tpl -> 'booking' ->> 'slot_minutes')::int, 30),
            coalesce((p_tpl -> 'booking' ->> 'buffer_after_minutes')::int, 0),
            coalesce((p_tpl -> 'booking' ->> 'min_notice_minutes')::int, 60),
            coalesce((p_tpl -> 'booking' ->> 'max_days_ahead')::int, 30))
    on conflict (service_id) do nothing;
  end if;
end $$;
comment on function private.template_service(app.locations, jsonb, jsonb, text) is
  'Template helper: the location''s active service with that name (oldest first), created when missing. o_created says which.';

------------------------------------------------------------------------------------------------
-- Dry-run report and merge for existing locations
------------------------------------------------------------------------------------------------

create function private.service_merge_plan(p_location_id uuid default null)
returns table (location_id uuid, service_name text, copies int, service_ids uuid[], outcome text, flagged boolean, detail text)
language sql stable set search_path = '' as $$
  with sig as (
    select s.id, s.location_id, s.created_at, lower(btrim(s.name)) as k, s.name,
           jsonb_build_object(
             'name', s.name, 'minutes', s.expected_minutes, 'prefix', s.ticket_prefix, 'color', s.color,
             'description', s.description, 'journey', s.journey_id,
             'booking', (select to_jsonb(b) - 'id' - 'service_id' - 'created_at' - 'updated_at' - 'version'
                         from app.booking_policies b where b.service_id = s.id),
             'payment', (select to_jsonb(p) - 'id' - 'service_id' - 'updated_at'
                         from app.payment_policies p where p.service_id = s.id)) as sig
    from app.services s
    where s.active and s.merged_into_id is null and (p_location_id is null or s.location_id = p_location_id)
  ), grp as (
    select g.location_id, g.k, g.sig, count(*)::int as copies, min(g.name) as name,
           array_agg(g.id order by g.created_at, g.id) as ids
    from sig g group by g.location_id, g.k, g.sig
  ), named as (
    select g.*, count(*) over (partition by g.location_id, g.k) as variants from grp g
  )
  select n.location_id, n.name, n.copies, n.ids,
         case when n.copies > 1 then 'merge' else 'keep' end,
         n.variants > 1,
         case when n.variants > 1 then (
           select string_agg(key, ', ' order by key)
           from jsonb_object_keys(n.sig) key
           where (select count(distinct o.sig -> key) from named o
                  where o.location_id = n.location_id and o.k = n.k) > 1) end
  from named n
  where n.copies > 1 or n.variants > 1
  order by n.location_id, n.name, n.copies desc
$$;
comment on function private.service_merge_plan(uuid) is
  'Dry run, no writes. One row per group of services at a location sharing a name: outcome merge '
  '(identical copies: name, minutes, prefix, colour, description, journey, booking and payment '
  'settings) or keep (a copy that differs, flagged = true, detail = what differs). Only names that '
  'repeat appear. Read this before running private.merge_identical_services.';

create function private.merge_identical_services(p_location_id uuid default null) returns int
language plpgsql set search_path = '' as $$
declare
  r record;
  v_survivor uuid;
  v_loser uuid;
  v_merged int := 0;
begin
  for r in select * from private.service_merge_plan(p_location_id) where outcome = 'merge' loop
    v_survivor := r.service_ids[1];
    foreach v_loser in array r.service_ids[2:] loop
      -- Every queue that offered a copy now offers the survivor.
      insert into app.queue_services (org_id, location_id, queue_id, service_id, sort_order)
      select org_id, location_id, queue_id, v_survivor, sort_order from app.queue_services where service_id = v_loser
      on conflict do nothing;
      delete from app.queue_services where service_id = v_loser;
      -- One row per service: the survivor's identical row wins.
      delete from app.booking_policies where service_id = v_loser;
      delete from app.payment_policies where service_id = v_loser;
      delete from app.availability_rules a where a.service_id = v_loser and exists (
        select 1 from app.availability_rules b where b.service_id = v_survivor
          and (b.staff_user_id, b.weekday, b.starts, b.ends, b.valid_from, b.valid_to)
              is not distinct from (a.staff_user_id, a.weekday, a.starts, a.ends, a.valid_from, a.valid_to));
      update app.availability_rules set service_id = v_survivor where service_id = v_loser;
      delete from app.capacity_rules a where a.service_id = v_loser and exists (
        select 1 from app.capacity_rules b where b.service_id = v_survivor
          and (b.scope, b.weekday, b.local_date) is not distinct from (a.scope, a.weekday, a.local_date));
      update app.capacity_rules set service_id = v_survivor where service_id = v_loser;
      insert into app.service_resources (org_id, location_id, service_id, counter_id)
      select org_id, location_id, v_survivor, counter_id from app.service_resources where service_id = v_loser
      on conflict do nothing;
      delete from app.service_resources where service_id = v_loser;
      delete from app.form_targets t where t.service_id = v_loser and exists (
        select 1 from app.form_targets b where b.service_id = v_survivor and b.channel = t.channel);
      update app.form_targets set service_id = v_survivor where service_id = v_loser;
      update app.slot_waitlist set service_id = v_survivor where service_id = v_loser;
      update app.routing_rules set service_id = v_survivor where service_id = v_loser;
      update app.journey_steps set service_id = v_survivor where service_id = v_loser;
      -- Capacity already taken under the copy still counts. A later cancellation releases the copy's
      -- row, not the survivor's, so the survivor errs on the full side until those dates pass.
      insert into app.appointment_slot_counts (org_id, service_id, slot_start, count)
      select org_id, v_survivor, slot_start, count from app.appointment_slot_counts where service_id = v_loser
      on conflict (service_id, slot_start) do update set count = app.appointment_slot_counts.count + excluded.count;
      insert into app.appointment_day_counts (org_id, service_id, local_date, count)
      select org_id, v_survivor, local_date, count from app.appointment_day_counts where service_id = v_loser
      on conflict (service_id, local_date) do update set count = app.appointment_day_counts.count + excluded.count;
      -- Visits, appointments, events and series keep pointing at the retired copy (I-1).
      update app.services set active = false, merged_into_id = v_survivor where id = v_loser;
    end loop;
    -- Each copy learned from a slice of the history; let the survivor relearn from all of it.
    delete from private.service_duration_stats where service_id = any (r.service_ids);
    v_merged := v_merged + 1;
  end loop;
  return v_merged;
end $$;
comment on function private.merge_identical_services(uuid) is
  'Operator tool, not an API: merges the groups private.service_merge_plan marks merge (all locations, '
  'or one). Survivor = oldest copy. Copies become inactive with merged_into_id set; queue links, '
  'policies, rules, resources, form targets, waitlist, routing and journey steps move to the survivor; '
  'its learned durations reset. Visits and appointments are not rewritten. Returns the groups merged.';
revoke all on function private.service_merge_plan(uuid), private.merge_identical_services(uuid)
  from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- Functions switched from services.queue_id to app.queue_services
------------------------------------------------------------------------------------------------

-- redefines private.join_core from 20261109094337_forms_engine.sql
CREATE OR REPLACE FUNCTION private.join_core(p_queue_id uuid, p_service_id uuid, p_name text, p_phone_e164 text, p_email text, p_party_size integer, p_locale text, p_idempotency_key uuid, p_source text, p_actor_kind app.actor_kind, p_actor_id uuid, p_device_key text DEFAULT NULL::text, p_answers jsonb DEFAULT '{}'::jsonb, p_group_key uuid DEFAULT NULL::uuid, p_onsite_code text DEFAULT NULL::text, p_routing_rule_id uuid DEFAULT NULL::uuid, p_arrive_after timestamp with time zone DEFAULT NULL::timestamp with time zone, OUT visit_id uuid, OUT token text)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  v_form uuid;
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
    from app.services s where s.id = p_service_id and private.queue_offers_service(q.id, s.id) and s.active;
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
  v_form := private.resolve_form(q.id, p_service_id);
  v_answers := private.validate_form_answers(
    q.org_id, coalesce((select fv.fields from app.form_versions fv where fv.id = v_form), '[]'), p_answers,
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
  if p_source in ('staff', 'sms', 'whatsapp', 'phone') then
    if v_phone is not null then
      select c.contact_id, c.guest_id into v_contact, v_guest
      from private.ensure_contact(q.org_id, 'phone', v_phone, null, v_name,
                                  case when p_source = 'staff' then 'staff' else 'online' end, true) c;
    end if;
    if v_email is not null then
      select c.contact_id, coalesce(v_guest, c.guest_id) into v_email_contact, v_guest
      from private.ensure_contact(q.org_id, 'email', v_email, v_guest, v_name,
                                  case when p_source = 'staff' then 'staff' else 'online' end, true) c;
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
  -- F2: the form version the guest saw, with the answers (empty when none were given).
  if v_form is not null then
    insert into app.form_responses (org_id, location_id, form_version_id, visit_id, answers)
    values (q.org_id, q.location_id, v_form, visit_id, v_answers);
  end if;
  perform private.bump_queue_version(q.id);
end $function$;

-- redefines api.join_queue from 20261030180718_join_later.sql
CREATE OR REPLACE FUNCTION api.join_queue(p_queue_id uuid, p_service_id uuid, p_name text, p_phone_e164 text, p_email text, p_party_size integer, p_locale text, p_idempotency_key uuid, p_device_key text DEFAULT NULL::text, p_join_pass text DEFAULT NULL::text, p_answers jsonb DEFAULT '{}'::jsonb, p_group_key uuid DEFAULT NULL::uuid, p_onsite_code text DEFAULT NULL::text, p_location_id uuid DEFAULT NULL::uuid, p_arrive_after timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS api.join_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    if not exists (select 1 from app.services s where s.id = p_service_id and private.queue_offers_service(v_queue, s.id)) then
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
end $function$;

-- redefines api.get_join_form from 20261109160124_agreement_signature_fields.sql
CREATE OR REPLACE FUNCTION api.get_join_form(p_queue_id uuid, p_service_id uuid DEFAULT NULL::uuid, p_channel text DEFAULT 'walk_in'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  q app.queues;
  v_form uuid;
begin
  if p_channel not in ('walk_in', 'booking') then
    raise exception 'invalid_input';
  end if;
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or private.org_pending_deletion(q.org_id) then
    raise exception 'not_found';
  end if;
  -- Only an active service of this queue counts, as in join_core; any other id is ignored.
  if p_service_id is not null and not exists (
    select 1 from app.services s where s.id = p_service_id and private.queue_offers_service(q.id, s.id) and s.active) then
    p_service_id := null;
  end if;
  v_form := private.resolve_form_for(q.id, p_service_id, p_channel);
  return jsonb_build_object(
    'form_version_id', v_form,
    'fields', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'key', e ->> 'key', 'label', e ->> 'label', 'help', e -> 'help', 'type', e ->> 'type',
               'options', e -> 'options', 'body', e -> 'body', 'required', coalesce((e ->> 'required')::boolean, false),
               'collect_guardian', case when coalesce((e ->> 'collect_guardian')::boolean, false) then 'true'::jsonb end,
               'must_be_true', case when coalesce((e ->> 'must_be_true')::boolean, false) then 'true'::jsonb end,
               'sensitivity', e ->> 'sensitivity'))
             order by ord)
      from app.form_versions fv,
           jsonb_array_elements(private.normalize_form_fields(fv.fields)) with ordinality t(e, ord)
      where fv.id = v_form and coalesce(e ->> 'visibility', 'guest') = 'guest'), '[]'));
end $function$;

-- redefines private.eta_at from 20261030171927_staff_shifts.sql
CREATE OR REPLACE FUNCTION private.eta_at(p_queue_id uuid, p_before bigint, OUT eta_state api.eta_state, OUT eta_low integer, OUT eta_high integer)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  q app.queues;
  -- Minutes for a visit with no service: the queue's active services on average, else the
  -- services.expected_minutes default.
  v_default numeric;
  v_ahead int;
  v_ahead_work numeric;
  v_avg numeric;
  v_sd numeric;
  v_busy_work numeric;
  v_mean numeric;
  v_sigma numeric;
  v_total int;
  v_reserved numeric := 0;
  v_servers int;
begin
  select * into q from app.queues where id = p_queue_id;
  if not found then
    return;
  end if;
  if not q.show_eta then
    eta_state := 'hidden';
    return;
  end if;
  if q.manual_state = 'paused' then
    eta_state := 'paused';
    return;
  end if;
  -- Presence (2B-S1) and shifts (2B-ORG5) are resolved in private.eta_servers.
  v_servers := private.eta_servers(q.id);
  if v_servers = 0 then
    eta_state := 'unstaffed';
    return;
  end if;

  select coalesce(avg(s.expected_minutes), 10) into v_default
  from app.queue_services qs
  join app.services s on s.id = qs.service_id
  where qs.queue_id = q.id and s.active;

  -- 2A-Q10: minutes and spread per visit are learned from history when there is enough of it.
  select count(*), coalesce(sum(coalesce(sm.minutes, v_default)), 0),
         coalesce(avg(coalesce(sm.minutes, v_default)), v_default),
         coalesce(avg(coalesce(sm.sd, 0.5 * v_default)), 0.5 * v_default)
  into v_ahead, v_ahead_work, v_avg, v_sd
  from app.visits v
  left join lateral private.service_minutes(v.service_id) sm on true
  where v.queue_id = q.id and v.status = 'waiting'
    and (p_before is null or v.sort_key < p_before);

  -- Guests being called or served still hold a server: what is left of their expected time,
  -- but never less than a fifth of it.
  select coalesce(sum(greatest(
           0.2 * coalesce(sm.minutes, v_default),
           coalesce(sm.minutes, v_default)
             - extract(epoch from now() - coalesce(v.serving_at, v.called_at, now())) / 60)), 0)
  into v_busy_work
  from app.visits v
  left join lateral private.service_minutes(v.service_id) sm on true
  where v.queue_id = q.id and v.status in ('called', 'serving');

  -- Expected guests who will check in ahead of this one (their virtual arrival, ADR 0010, is not
  -- later than when this guest would start) take server time too. Each one found pushes the start
  -- later, so look again; three rounds settle any realistic day. Off unless the queue opts in.
  if q.eta_reserves_appointments then
    for i in 1..3 loop
      select coalesce(sum(coalesce((private.service_minutes(x.service_id)).minutes, v_default)), 0) into v_reserved
      from app.visits x
      where x.queue_id = q.id and x.status = 'expected' and x.scheduled_at is not null
        and x.scheduled_at - make_interval(mins => q.early_checkin_minutes)
            <= now() + ((v_ahead_work + v_busy_work + v_reserved) / v_servers)::float8 * interval '1 minute'
        and x.scheduled_at + make_interval(mins => q.no_show_after_minutes) > now();
    end loop;
    v_ahead_work := v_ahead_work + v_reserved;
  end if;

  -- (work ahead + busy) / servers is when the servers would clear everything ahead on average,
  -- but a guest starts as soon as one server frees after the last guest ahead has started, while
  -- the other servers are still mid-service: on average (servers - 1) / servers of half a
  -- service earlier (#548). With one server nothing changes.
  -- 2A-Q11: a manual override replaces the formula until it expires. It is the wait for the whole
  -- line, shared out by place: guest n of n waiting is told the override, earlier guests less.
  if q.wait_override_minutes is not null and q.wait_override_until > now() then
    select count(*)::int into v_total from app.visits v where v.queue_id = q.id and v.status = 'waiting';
    v_mean := q.wait_override_minutes::numeric * (v_ahead + 1) / greatest(v_total, v_ahead + 1);
    eta_low := (round(0.75 * v_mean / 5) * 5)::int;
    eta_high := greatest((ceil(1.25 * v_mean / 5) * 5)::int, eta_low + 5);
    eta_state := case when v_ahead = 0 then 'next' else 'override' end;
    return;
  end if;

  v_mean := greatest(0, (v_ahead_work + v_busy_work) / v_servers
                        - (v_servers - 1) * v_avg / (2 * v_servers));
  v_sigma := v_sd * sqrt(v_ahead + 1) / v_servers;
  eta_low := (round(greatest(0, v_mean - v_sigma) / 5) * 5)::int;
  eta_high := greatest((ceil((v_mean + v_sigma) / 5) * 5)::int, eta_low + 5);

  eta_state := case when v_ahead = 0 then 'next' else private.eta_range_state(eta_low, eta_high) end;
end $function$;

-- redefines api.get_location_public from 20261109130339_org_privacy_contact.sql
CREATE OR REPLACE FUNCTION api.get_location_public(p_location_slug text)
 RETURNS api.location_public
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  l app.locations;
  result api.location_public;
begin
  select * into l from app.locations where slug = p_location_slug;
  if not found then
    select loc.* into l
    from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_location_slug;
  end if;
  if l.id is null or private.org_pending_deletion(l.org_id) then
    raise exception 'not_found';
  end if;

  select l.id, l.name, l.slug, l.tz, l.address, l.contact,
         coalesce(array_agg(row(
           q.id, q.name, q.manual_state, r.reason is null, r.reason,
           (select count(*)::int from app.visits v where v.queue_id = q.id and v.status = 'waiting'),
           e.eta_state, e.eta_low, e.eta_high, q.pulse_id,
           array(select row(s.id, s.name, s.description)::api.public_service
                 from app.queue_services qs
                 join app.services s on s.id = qs.service_id
                 where qs.queue_id = q.id and s.active
                 order by s.sort_order, s.name)
         )::api.public_queue order by q.sort_order, q.name) filter (where q.id is not null),
         '{}'),
         l.country_code,
         (select s.turnstile_site_key from private.deployment_settings s),
         (select o.retention_days from app.organizations o where o.id = l.org_id),
         exists (select 1 from app.routing_rules rr join app.queues tq on tq.id = rr.target_queue_id and tq.archived_at is null
                 where rr.location_id = l.id and rr.active),
         private.channel_enabled(l.org_id, 'sms'),
         (select jsonb_strip_nulls(jsonb_build_object(
                   'name', p.officer_name, 'email', p.email,
                   'phone', case when p.notice_prefs ->> 'show_phone' = 'true' then p.phone end))
          from app.org_privacy p where p.org_id = l.org_id)
  into result
  from (select 1) one
  left join app.queues q on q.location_id = l.id and q.archived_at is null
  -- This page is the online entry point, so the hourly online ceiling counts as not accepting.
  left join lateral (
    select coalesce(private.queue_not_accepting_reason(q.id),
                    case when app.online_joins_paused_until(q) is not null then 'online_full' end) as reason
  ) r on true
  left join lateral private.queue_eta(q.id) e on true;
  return result;
end $function$;

-- redefines api.transfer_visit from 20261109102446_queue_scope_actions.sql
CREATE OR REPLACE FUNCTION api.transfer_visit(p_visit_id uuid, p_to_queue_id uuid, p_to_service_id uuid, p_expected_version integer, p_idempotency_key uuid)
 RETURNS api.visit_row
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v app.visits;
  tq app.queues;
  claim record;
  pl record;
  v_service uuid;
  v_after uuid;
  v_from_after uuid;
  v_sort bigint;
  v_number int;
  v_display text;
  v_renumbered boolean := false;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_to_queue_id is null or p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;
  select * into tq from app.queues
  where id = p_to_queue_id and org_id = v.org_id and location_id = v.location_id
    and archived_at is null;
  if not found or not private.has_queue_access(v.org_id, tq.id, 'staff')
     or (p_to_service_id is not null and not exists (
       select 1 from app.services s
       where s.id = p_to_service_id and s.org_id = v.org_id and private.queue_offers_service(tq.id, s.id) and s.active)) then
    raise exception 'not_found';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'transfer_visit', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status <> 'waiting' then
    raise exception 'illegal_transition' using detail = format('transfer from %s', v.status);
  end if;

  -- Services belong to one queue: moving queues without naming a service leaves it unset.
  v_service := case when p_to_service_id is not null then p_to_service_id
                    when tq.id = v.queue_id then v.service_id end;
  v_sort := v.sort_key;
  v_number := v.ticket_number;
  v_display := v.display_ticket;

  if tq.id = v.queue_id and v_service is not distinct from v.service_id then
    result := private.visit_row(v.id);
    result.last_event_id := null;
    perform private.save_idempotent('transfer_visit', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  select w.id into v_from_after
  from app.visits w
  where w.queue_id = v.queue_id and w.service_day = v.service_day and w.status = 'waiting'
    and (w.sort_key, w.id) < (v.sort_key, v.id)
  order by w.sort_key desc, w.id desc
  limit 1;

  if tq.id <> v.queue_id then
    if private.queue_not_accepting_reason(tq.id) is not null then
      raise exception 'queue_not_accepting';
    end if;
    -- Filed behind the last waiting visit that joined before this one.
    select w.id into v_after
    from app.visits w
    where w.queue_id = tq.id and w.service_day = v.service_day and w.status = 'waiting'
      and (w.joined_at, w.id) < (v.joined_at, v.id)
    order by w.sort_key desc, w.id desc
    limit 1;
    select * into pl from private.place_in_queue(tq.id, v.service_day, v.id, v_after);
    v_sort := pl.new_sort_key;
    v_renumbered := pl.renumbered;

    -- The ticket stays unless the target queue issues the same prefix (its counter would hand the
    -- same number out later) or already holds this number; then the target issues the next one.
    if tq.ticket_prefix = v.ticket_prefix or exists (
      select 1 from app.visits t
      where t.queue_id = tq.id and t.service_day = v.service_day
        and t.ticket_prefix = v.ticket_prefix and t.ticket_number = v.ticket_number) then
      loop
        v_number := private.next_ticket(tq.id, v.ticket_prefix, v.service_day);
        exit when not exists (
          select 1 from app.visits t
          where t.queue_id = tq.id and t.service_day = v.service_day
            and t.ticket_prefix = v.ticket_prefix and t.ticket_number = v_number);
      end loop;
      v_display := v.ticket_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0');
    end if;
  end if;

  perform private.set_actor('staff', (select auth.uid()), 'transferred', null,
    jsonb_build_object('from_queue_id', v.queue_id, 'to_queue_id', tq.id,
                       'from_service_id', v.service_id, 'to_service_id', v_service,
                       'from_sort_key', v.sort_key, 'to_sort_key', v_sort,
                       'from_after_visit_id', v_from_after, 'to_after_visit_id', v_after,
                       'from_ticket_number', v.ticket_number, 'to_ticket_number', v_number,
                       'from_display_ticket', v.display_ticket, 'to_display_ticket', v_display,
                       'renumbered', v_renumbered));
  update app.visits
  set queue_id = tq.id, service_id = v_service, sort_key = v_sort,
      ticket_number = v_number, display_ticket = v_display
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);
  if tq.id <> v.queue_id then
    perform private.bump_queue_version(tq.id);
  end if;

  result := private.visit_row(v.id);
  perform private.save_idempotent('transfer_visit', p_idempotency_key, to_jsonb(result));
  return result;
end $function$;

-- redefines private.book_core from 20261030071001_book_appointment.sql
CREATE OR REPLACE FUNCTION private.book_core(p_location_id uuid, p_service_id uuid, p_slot_start timestamp with time zone, p_staff_user_id uuid, p_name text, p_phone_e164 text, p_email text, p_party_size integer, p_locale text, p_idempotency_key uuid, p_source text, p_actor_kind app.actor_kind, p_actor_id uuid, p_override boolean, OUT appointment app.appointments, OUT is_new boolean)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  l app.locations;
  s app.services;
  bp app.booking_policies;
  slot private.slot_candidate;
  v_name text := nullif(btrim(p_name), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone_e164, ''), '[[:space:]().-]', '', 'g'), '');
  v_email text := nullif(lower(btrim(p_email)), '');
  v_locale text := nullif(btrim(p_locale), '');
  v_date date;
  v_staff uuid;
  v_guest uuid;
  v_contact uuid;
  v_email_contact uuid;
  v_id uuid := gen_random_uuid();
begin
  select * into l from app.locations where id = p_location_id;
  select * into s from app.services where id = p_service_id and location_id = p_location_id;
  if l.id is null or s.id is null then raise exception 'not_found'; end if;
  if p_idempotency_key is null or p_slot_start is null
     or v_name is null or length(v_name) > 60 or v_name ~ '[[:cntrl:]]'
     or v_phone !~ '^\+[1-9][0-9]{6,14}$'
     or length(v_locale) > 35 or v_locale !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$'
     or length(v_email) > 254
     or v_email !~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$' then
    raise exception 'invalid_input';
  end if;
  if coalesce(p_party_size, 1) <> 1 then raise exception 'party_size_out_of_range'; end if;
  perform private.lock_location(l.id);

  select a.* into appointment from app.appointments a
  where a.location_id = l.id and a.idempotency_key = p_idempotency_key;
  if found then
    is_new := false;
    return;
  end if;
  is_new := true;

  if not exists (select 1 from app.organizations o where o.id = l.org_id and o.status = 'active') then
    raise exception 'org_suspended';
  end if;
  if p_source = 'guest' then
    if private.is_blocked(l.org_id, v_phone, v_email) then
      raise exception 'rate_limited' using detail = 'client';
    end if;
    -- one phone or email cannot hold more than 3 upcoming bookings in the org
    if (select count(*) from app.appointments a
        where a.org_id = l.org_id and a.status = 'booked' and a.starts_at > now()
          and ((v_phone is not null and a.guest_phone_e164 = v_phone)
               or (v_email is not null and a.guest_email = v_email))) >= 3 then
      raise exception 'rate_limited' using detail = 'client';
    end if;
    if (select count(*) from app.appointments a
        where a.location_id = l.id and a.source = 'guest' and a.created_at > now() - interval '1 minute') >= l.booking_rate_per_min then
      raise exception 'rate_limited' using detail = 'network';
    end if;
  end if;

  v_date := (p_slot_start at time zone l.tz)::date;
  -- Valid at all (hours, grid, notice, horizon, staff)? Then is there room?
  select c.* into slot from private.slot_candidates(s.id, v_date - 1, v_date + 1, now(), true) c
  where c.slot_start = p_slot_start;
  if slot.slot_start is null then raise exception 'slot_unavailable'; end if;
  if not coalesce(p_override, false) and not exists (
       select 1 from private.slot_candidates(s.id, v_date - 1, v_date + 1) c where c.slot_start = p_slot_start) then
    raise exception 'slot_full';
  end if;

  v_staff := p_staff_user_id;
  if v_staff is not null then
    if not (v_staff = any (slot.free_staff)) and not (slot.any_staff and exists (
         select 1 from app.memberships m where m.org_id = l.org_id and m.user_id = v_staff)) then
      raise exception 'slot_unavailable';
    end if;
  elsif cardinality(slot.free_staff) > 0 then -- the least booked that day takes it
    select f into v_staff from unnest(slot.free_staff) f
    order by (select count(*) from app.appointments a where a.staff_user_id = f and a.local_date = v_date
                and a.status in ('booked', 'checked_in')), f limit 1;
  end if;

  if p_source = 'staff' then -- staff see the guest, so staff bookings record or link the contact
    if v_phone is not null then
      select c.contact_id, c.guest_id into v_contact, v_guest
      from private.ensure_contact(l.org_id, 'phone', v_phone, null, v_name, p_source, true) c;
    end if;
    if v_email is not null then
      select c.contact_id, coalesce(v_guest, c.guest_id) into v_email_contact, v_guest
      from private.ensure_contact(l.org_id, 'email', v_email, v_guest, v_name, p_source, true) c;
      v_contact := coalesce(v_contact, v_email_contact);
    end if;
  end if;

  select bp2.* into bp from app.booking_policies bp2 where bp2.service_id = s.id;
  perform private.set_actor(p_actor_kind, p_actor_id, null, null, jsonb_build_object('source', p_source));
  insert into app.appointments (id, org_id, location_id, service_id, queue_id, staff_user_id, starts_at, ends_at,
                                local_date, guest_name, guest_id, contact_id, guest_phone_e164, guest_email, locale,
                                guest_token_hash, source, idempotency_key)
  values (v_id, l.org_id, l.id, s.id, private.service_queue(s.id), v_staff, slot.slot_start, slot.slot_end, v_date, v_name,
          v_guest, v_contact, v_phone, v_email,
          coalesce(v_locale, (select o.default_locale from app.organizations o where o.id = l.org_id)),
          case when p_source = 'guest' then private.token_hash(private.visit_token(v_id, p_idempotency_key)) end,
          p_source, p_idempotency_key)
  returning * into appointment;
  perform private.take_capacity(l.org_id, s.id, slot.slot_start, v_date);
end $function$;

-- redefines api.book_event_seats from 20261030170603_events.sql
CREATE OR REPLACE FUNCTION api.book_event_seats(p_event_id uuid, p_name text, p_phone_e164 text, p_email text, p_party_size integer, p_idempotency_key uuid)
 RETURNS api.booking_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  e app.events;
  l app.locations;
  s app.services;
  a app.appointments;
  v_name text := nullif(btrim(p_name), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone_e164, ''), '[[:space:]().-]', '', 'g'), '');
  v_email text := nullif(lower(btrim(p_email)), '');
  v_seats int := coalesce(p_party_size, 1);
  v_id uuid := gen_random_uuid();
begin
  select * into e from app.events where id = p_event_id;
  if e.id is null or not e.public or e.status <> 'scheduled' or upper(e.during) <= now() then raise exception 'not_found'; end if;
  select * into l from app.locations where id = e.location_id;
  select * into s from app.services where id = e.service_id;
  if p_idempotency_key is null or v_name is null or length(v_name) > 60 or v_name ~ '[[:cntrl:]]'
     or (v_phone is null and v_email is null)
     or (v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$')
     or (v_email is not null and (length(v_email) > 254
         or v_email !~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$'))
     or v_seats not between 1 and 20 then
    raise exception 'invalid_input';
  end if;
  perform private.lock_location(l.id);
  -- A repeated key returns the earlier booking and takes no seats.
  select x.* into a from app.appointments x where x.location_id = l.id and x.idempotency_key = p_idempotency_key;
  if not found then
    select * into e from app.events where id = p_event_id for update;
    if e.status <> 'scheduled' then raise exception 'not_found'; end if;
    if not exists (select 1 from app.organizations o where o.id = l.org_id and o.status = 'active') then
      raise exception 'org_suspended';
    end if;
    if private.is_blocked(l.org_id, v_phone, v_email) then raise exception 'rate_limited' using detail = 'client'; end if;
    if (select count(*) from app.appointments x
        where x.location_id = l.id and x.source = 'guest' and x.created_at > now() - interval '1 minute') >= l.booking_rate_per_min then
      raise exception 'rate_limited' using detail = 'network';
    end if;
    if e.booked + v_seats > e.capacity then raise exception 'event_full'; end if;
    perform private.set_actor('guest', null, null, null, jsonb_build_object('source', 'guest'));
    insert into app.appointments (id, org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date, guest_name,
                                  guest_phone_e164, guest_email, locale, guest_token_hash, source, idempotency_key, event_id, seats)
    values (v_id, l.org_id, l.id, s.id, private.service_queue(s.id), lower(e.during), upper(e.during), (lower(e.during) at time zone l.tz)::date,
            v_name, v_phone, v_email, (select o.default_locale from app.organizations o where o.id = l.org_id),
            private.token_hash(private.visit_token(v_id, p_idempotency_key)), 'guest', p_idempotency_key, e.id, v_seats)
    returning * into a;
    update app.events set booked = booked + v_seats where id = e.id;
  end if;
  if a.event_id is distinct from p_event_id then raise exception 'invalid_input'; end if;
  return row(private.visit_token(a.id, p_idempotency_key), a.starts_at, a.ends_at, e.title, l.name, a.status::text)::api.booking_result;
end $function$;

-- redefines private.offer_freed_slot from 20261031183533_waitlist_paid_holds.sql
CREATE OR REPLACE FUNCTION private.offer_freed_slot(p_a app.appointments)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  l app.locations;
  s app.services;
  w app.slot_waitlist;
  held app.appointments;
  v_expires timestamptz;
  saved text[];
begin
  if p_a.event_id is not null or p_a.starts_at <= now() then return; end if;
  if not exists (select 1 from private.slot_candidates(p_a.service_id, p_a.local_date - 1, p_a.local_date + 1) c
                 where c.slot_start = p_a.starts_at) then
    return;
  end if;
  -- Offers hold seats like unpaid holds, so none is made while a paid service's cap is full; the entry keeps waiting.
  if exists (select 1 from app.payment_policies x where x.org_id = p_a.org_id and x.service_id = p_a.service_id and x.mode <> 'none')
     and private.payments_connected(p_a.org_id) and private.live_holds(p_a.service_id, p_a.local_date) >= 20 then
    return;
  end if;
  select x.* into w from app.slot_waitlist x
  where x.service_id = p_a.service_id and x.status = 'waiting' and x.wanted_day = p_a.local_date
    and (x.during is null or x.during @> p_a.starts_at)
  order by x.created_at, x.id limit 1 for update skip locked;
  if w.id is null then return; end if;
  select * into l from app.locations where id = p_a.location_id;
  select * into s from app.services where id = p_a.service_id;
  v_expires := least(now() + make_interval(mins => l.waitlist_hold_minutes), p_a.starts_at);
  -- The caller's actor context (a staff cancel, say) must survive this offer.
  saved := array[current_setting('app.actor_kind', true), current_setting('app.actor_id', true),
                 current_setting('app.action', true), current_setting('app.reason', true),
                 current_setting('app.event_payload', true)];
  perform private.set_actor('system', null, 'waitlist_offer');
  insert into app.appointments (org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date, status, guest_name,
                                guest_phone_e164, guest_email, locale, guest_token_hash, source, idempotency_key)
  values (p_a.org_id, p_a.location_id, p_a.service_id, private.service_queue(s.id), p_a.starts_at, p_a.ends_at, p_a.local_date, 'offered', w.name,
          w.guest_phone_e164, w.guest_email,
          (select o.default_locale from app.organizations o where o.id = p_a.org_id), w.token_hash, 'guest', gen_random_uuid())
  returning * into held;
  perform private.take_capacity(held.org_id, held.service_id, held.starts_at, held.local_date);
  update app.slot_waitlist set status = 'offered', offered_slot = tstzrange(held.starts_at, held.ends_at),
         offer_expires_at = v_expires, appointment_id = held.id where id = w.id;
  perform private.enqueue_appointment_notification(held, 'slot_offer', jsonb_build_object(
    'service', s.name, 'offer_expires', to_char(v_expires at time zone l.tz, 'HH24:MI')));
  if saved[1] is not null then
    perform set_config('app.actor_kind', saved[1], true), set_config('app.actor_id', coalesce(saved[2], ''), true),
            set_config('app.action', coalesce(saved[3], ''), true), set_config('app.reason', coalesce(saved[4], ''), true),
            set_config('app.event_payload', coalesce(saved[5], '{}'), true);
  end if;
end $function$;

-- redefines private.slot_candidates from 20261112132912_port_internal_2026_11_12.sql
CREATE OR REPLACE FUNCTION private.slot_candidates(p_service_id uuid, p_from date, p_to date, p_now timestamp with time zone DEFAULT now(), p_ignore_capacity boolean DEFAULT false)
 RETURNS SETOF private.slot_candidate
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  s app.services;
  bp app.booking_policies;
  l app.locations;
  dur int;
  today date;
  has_rules boolean;
  v_provider uuid;
begin
  select * into s from app.services where id = p_service_id and active;
  select * into bp from app.booking_policies where service_id = p_service_id and bookable;
  if s.id is null or bp.id is null then return; end if;
  select * into l from app.locations where id = s.location_id;
  if not exists (select 1 from app.organizations o where o.id = l.org_id and o.status = 'active') then return; end if;
  dur := coalesce(bp.duration_minutes, s.expected_minutes);
  -- #1388: a provider line with its person takes bookings for that person only. Every availability window
  -- of the service (an "anyone" window too) is theirs, and other people's windows don't count.
  -- #75: only when one queue offers the service. A service several lines offer is not tied to the first
  -- line's person: anyone with availability can take it (which person's line it lands in is a later rule).
  select q.provider_user_id into v_provider from app.queues q
  where q.id = private.service_queue(s.id) and q.kind = 'provider'
    and (select count(*) from app.queue_services qs join app.queues oq on oq.id = qs.queue_id
         where qs.service_id = s.id and oq.archived_at is null) = 1;
  today := (p_now at time zone l.tz)::date;
  has_rules := exists (select 1 from app.availability_rules r
                       where r.location_id = l.id and (r.service_id is null or r.service_id = s.id));

  return query
  with days as (
    select gs::date as d from generate_series(greatest(p_from, today), least(p_to, today + bp.max_days_ahead), '1 day') gs
  ),
  biz as ( -- opening windows as instants (a window may cross midnight)
    select d.d,
           (d.d + o.opens) at time zone l.tz as w_start,
           (d.d + case when o.closes <= o.opens then 1 else 0 end + o.closes) at time zone l.tz as w_end
    from days d
    cross join lateral (
      select e.opens, e.closes from app.hours_exceptions e
      where e.location_id = l.id and e.date = d.d and not e.closed
      union all
      select h.opens, h.closes from app.business_hours h
      where h.location_id = l.id and h.weekday = extract(dow from d.d)
        and not exists (select 1 from app.hours_exceptions e where e.location_id = l.id and e.date = d.d)
    ) o
  ),
  avail as ( -- availability windows per staff member (null = any staff; the line's person on a provider line)
    select d.d, coalesce(r.staff_user_id, v_provider) as staff_user_id,
           (d.d + r.starts) at time zone l.tz as a_start,
           (d.d + case when r.ends <= r.starts then 1 else 0 end + r.ends) at time zone l.tz as a_end
    from days d join app.availability_rules r
      on r.location_id = l.id and (r.service_id is null or r.service_id = s.id)
     and r.weekday = extract(dow from d.d)
     and (r.valid_from is null or d.d >= r.valid_from) and (r.valid_to is null or d.d <= r.valid_to)
    where v_provider is null or coalesce(r.staff_user_id, v_provider) = v_provider
    union all
    select x.local_date, coalesce(x.staff_user_id, v_provider),
           (x.local_date + x.starts) at time zone l.tz,
           (x.local_date + case when x.ends <= x.starts then 1 else 0 end + x.ends) at time zone l.tz
    from app.availability_exceptions x
    where x.location_id = l.id and x.kind = 'extra' and x.local_date between p_from and p_to
      and (v_provider is null or coalesce(x.staff_user_id, v_provider) = v_provider)
  ),
  off as ( -- unavailable windows (null staff = everyone; null times = the whole day)
    select x.staff_user_id,
           tstzrange((x.local_date + coalesce(x.starts, time '00:00')) at time zone l.tz,
                     case when x.starts is null then (x.local_date + 1) at time zone l.tz
                          else (x.local_date + case when x.ends <= x.starts then 1 else 0 end + x.ends) at time zone l.tz end) as r
    from app.availability_exceptions x
    where x.location_id = l.id and x.kind = 'unavailable' and x.local_date between p_from - 1 and p_to
  ),
  rs as ( -- resources that can serve the service
    select ctr.id from app.counters ctr
    where ctr.location_id = l.id and ctr.active
      and (not exists (select 1 from app.service_resources m where m.service_id = s.id)
           or exists (select 1 from app.service_resources m where m.service_id = s.id and m.counter_id = ctr.id))
  ),
  cand as (
    select (b.w_start + m * interval '1 minute') as st,
           (b.w_start + (m + dur) * interval '1 minute') as en,
           b.d
    from biz b
    cross join lateral generate_series(bp.slot_offset_minutes,
        (extract(epoch from (b.w_end - b.w_start)) / 60)::int - dur, bp.slot_minutes) m
  ),
  checked as (
    select c.st, c.en, c.d,
      -- staff who could take the slot: covered by an availability window, not off, not double-booked
      (select coalesce(array_agg(distinct a.staff_user_id), '{}'::uuid[]) from avail a
        where a.staff_user_id is not null and a.d = c.d and a.a_start <= c.st and a.a_end >= c.en
          and not exists (select 1 from off f where (f.staff_user_id is null or f.staff_user_id = a.staff_user_id)
                          and f.r && tstzrange(c.st, c.en))
          and not exists (select 1 from app.time_blocks tb join app.counters bc on bc.id = tb.counter_id
                          where bc.location_id = l.id and bc.kind = 'staff' and bc.member_user_id = a.staff_user_id
                            and tb.during && tstzrange(c.st, c.en))
          and not exists (select 1 from app.appointments ap
                          where ap.staff_user_id = a.staff_user_id and (ap.status in ('booked', 'checked_in') or ap.payment_due_at is not null)
                            and ap.starts_at >= c.st - interval '1 day' and ap.starts_at < c.en + interval '1 day'
                            and tstzrange(ap.starts_at - bp.buffer_before_minutes * interval '1 minute',
                                          ap.ends_at + bp.buffer_after_minutes * interval '1 minute') && tstzrange(c.st, c.en))
      ) as free_staff,
      exists (select 1 from avail a where a.staff_user_id is null and a.d = c.d and a.a_start <= c.st and a.a_end >= c.en) as any_staff,
      exists (select 1 from off f where f.staff_user_id is null and f.r && tstzrange(c.st, c.en)) as closed_all,
      -- 2B-A11: every resource that can do the service (its mapped resources, else all active ones at the
      -- location) is blocked during the slot.
      (exists (select 1 from rs) and not exists (
         select 1 from rs where not exists (select 1 from app.time_blocks tb
                                            where tb.counter_id = rs.id and tb.during && tstzrange(c.st, c.en)))) as blocked_all,
      (select count(*)::int from app.appointments ap
        where (bp.buffer_before_minutes > 0 or bp.buffer_after_minutes > 0)
          and ap.service_id = s.id and ap.staff_user_id is null and (ap.status in ('booked', 'checked_in') or ap.payment_due_at is not null)
          and ap.starts_at <> c.st and ap.starts_at >= c.st - interval '1 day' and ap.starts_at < c.en + interval '1 day'
          and tstzrange(ap.starts_at - bp.buffer_before_minutes * interval '1 minute',
                        ap.ends_at + bp.buffer_after_minutes * interval '1 minute') && tstzrange(c.st, c.en)) as overlap,
      coalesce((select cr.capacity from app.capacity_rules cr
                where cr.service_id = s.id and cr.scope = 'slot'
                  and (cr.local_date = c.d or (cr.local_date is null and (cr.weekday is null or cr.weekday = extract(dow from c.d))))
                order by (cr.local_date is not null) desc, (cr.weekday is not null) desc limit 1), 1) as cap,
      (select cr.capacity from app.capacity_rules cr
        where cr.service_id = s.id and cr.scope = 'day'
          and (cr.local_date = c.d or (cr.local_date is null and (cr.weekday is null or cr.weekday = extract(dow from c.d))))
        order by (cr.local_date is not null) desc, (cr.weekday is not null) desc limit 1) as day_cap,
      coalesce((select n.count from app.appointment_slot_counts n where n.service_id = s.id and n.slot_start = c.st), 0) as used,
      coalesce((select n.count from app.appointment_day_counts n where n.service_id = s.id and n.local_date = c.d), 0) as day_used
    from cand c
    where c.st >= p_now + bp.min_notice_minutes * interval '1 minute'
  )
  select k.st, k.en,
         case when p_ignore_capacity then 1 else least(k.cap - k.used - k.overlap, coalesce(k.day_cap - k.day_used, 1000000),
              case when k.any_staff or not has_rules then 1000000 else cardinality(k.free_staff) end)::int end,
         k.free_staff, k.any_staff
  from checked k
  where not k.closed_all and not k.blocked_all
    and (not has_rules or k.any_staff or cardinality(k.free_staff) > 0)
    and (p_ignore_capacity or least(k.cap - k.used - k.overlap, coalesce(k.day_cap - k.day_used, 1000000),
              case when k.any_staff or not has_rules then 1000000 else cardinality(k.free_staff) end) > 0)
  order by k.st;
end $function$;

-- redefines api.apply_industry_template from 20261112132912_port_internal_2026_11_12.sql
CREATE OR REPLACE FUNCTION api.apply_industry_template(p_location_id uuid, p_template_key text, p_idempotency_key uuid, p_providers text[] DEFAULT NULL::text[], p_pool boolean DEFAULT false)
 RETURNS api.template_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  loc app.locations;
  tpl jsonb;
  v_version int;
  claim record;
  q jsonb;
  s jsonb;
  r jsonb;
  v_queue app.queues;
  v_pool app.queues;
  v_lines uuid[] := '{}';
  v_line uuid;
  v_name text;
  v_services jsonb;
  v_form app.forms;
  v_form_name text;
  v_mode text;
  v_service uuid;
  v_created boolean;
  result api.template_result;
begin
  select * into loc from app.locations l where l.id = p_location_id;
  if not found or not private.has_role(loc.org_id, loc.id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(loc.org_id, loc.id, 'admin') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  -- The newest catalog version; the rows created below are copies that later versions never touch.
  select c.payload || jsonb_build_object('health_tagged', c.health_tagged), c.version, c.mode
  into tpl, v_version, v_mode
  from app.template_catalog c
  where c.key = p_template_key order by c.version desc limit 1;
  if tpl is null or p_idempotency_key is null then raise exception 'not_found'; end if;
  -- A template may list its services once at the top level and name them per queue; expand the names
  -- so the rest of the function sees the one shape every catalog entry used before.
  if jsonb_typeof(tpl -> 'services') = 'array' then
    tpl := jsonb_set(tpl, '{queues}', (
      select coalesce(jsonb_agg(jsonb_set(qq.v, '{services}', (
        select coalesce(jsonb_agg(case when jsonb_typeof(e.v) = 'string'
          then coalesce((select d.v from jsonb_array_elements(tpl -> 'services') d(v)
                         where private.catalog_text(d.v -> 'name') = private.catalog_text(e.v)),
                        jsonb_build_object('name', e.v, 'minutes', 10))
          else e.v end order by e.n), '[]')
        from jsonb_array_elements(qq.v -> 'services') with ordinality e(v, n)))
        order by qq.n), '[]')
      from jsonb_array_elements(tpl -> 'queues') with ordinality qq(v, n)));
  end if;
  -- Providers: 1 to 20 distinct names of 1 to 80 characters (the owner names each personal line).
  if p_providers is not null and (
       cardinality(p_providers) not between 1 and 20
       or exists (select 1 from unnest(p_providers) n where n is null or length(btrim(n)) not between 1 and 80)
       or (select count(distinct lower(btrim(n))) from unnest(p_providers) n) <> cardinality(p_providers)) then
    raise exception 'invalid_input' using detail = 'providers';
  end if;

  select * into claim from private.claim_idempotent(loc.org_id, 'apply_industry_template', p_idempotency_key);
  if claim.replay then
    if claim.response ->> 'template_key' is distinct from p_template_key then
      raise exception 'invalid_input'; -- the key was used for a different template
    end if;
    return jsonb_populate_record(null::api.template_result, claim.response);
  end if;
  if exists (select 1 from app.visits v
             where v.location_id = loc.id and v.service_day = private.service_day(loc.id)) then
    raise exception 'invalid_input' using detail = 'location_has_visits';
  end if;

  result := row(p_template_key, 0, 0, 0);
  if (tpl ->> 'health_tagged')::boolean then
    -- The tag covers the whole organization, so it needs an org-wide admin, not one scoped to a place.
    if not private.has_role(loc.org_id, null, 'admin') then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
    update app.locations set display_names_enabled = false where org_id = loc.org_id and display_names_enabled;
    update app.organizations set health_tagged = true where id = loc.org_id;
  end if;

  if p_providers is null then
    for q in select * from jsonb_array_elements(tpl -> 'queues') loop
      -- Applying again, or after hand-made setup, never duplicates a queue of the same name.
      v_name := private.catalog_text(q -> 'name');
      select * into v_queue from app.queues x
      where x.location_id = loc.id and x.archived_at is null and x.name = v_name;
      if not found then
        insert into app.queues (org_id, location_id, name, ticket_prefix, show_eta,
                                party_size_enabled, party_size_min, party_size_max,
                                origin_template, origin_version)
        values (loc.org_id, loc.id, v_name, q ->> 'prefix', (q ->> 'show_eta')::boolean,
                q ? 'party_max', coalesce((q ->> 'party_min')::int, 1), coalesce((q ->> 'party_max')::int, 1),
                p_template_key, v_version)
        returning * into v_queue;
        result.queues_created := result.queues_created + 1;
      end if;
      v_lines := v_lines || v_queue.id;
      for s in select * from jsonb_array_elements(q -> 'services') loop
        select ts.o_service_id, ts.o_created into v_service, v_created
        from private.template_service(loc, s, tpl, v_mode) ts;
        if v_created then
          result.services_created := result.services_created + 1;
        end if;
        insert into app.queue_services (org_id, location_id, queue_id, service_id, sort_order)
        values (loc.org_id, loc.id, v_queue.id, v_service,
                (select coalesce(max(x.sort_order) + 1, 0) from app.queue_services x where x.queue_id = v_queue.id))
        on conflict do nothing;
      end loop;
    end loop;
  else
    -- One personal line per provider, plus the optional pool; every line offers all the template's
    -- services (first occurrence of each name) and takes its ETA and party settings from the first queue.
    q := tpl -> 'queues' -> 0;
    select coalesce(jsonb_agg(x.s order by x.ord), '[]') into v_services
    from (select distinct on (private.catalog_text(e.s -> 'name')) e.s, e.ord
          from (select sv.s, qi.n * 1000 + sv.n as ord
                from jsonb_array_elements(tpl -> 'queues') with ordinality qi(qq, n),
                     jsonb_array_elements(qi.qq -> 'services') with ordinality sv(s, n)) e
          order by private.catalog_text(e.s -> 'name'), e.ord) x;
    if p_pool then
      select * into v_pool from app.queues x
      where x.location_id = loc.id and x.archived_at is null and x.kind = 'pool' order by x.created_at limit 1;
      if not found then
        v_name := 'Anyone available';
        if exists (select 1 from app.queues x where x.location_id = loc.id and x.archived_at is null and x.name = v_name) then
          raise exception 'invalid_input' using detail = 'pool_name_taken';
        end if;
        insert into app.queues (org_id, location_id, name, kind, ticket_prefix, show_eta,
                                party_size_enabled, party_size_min, party_size_max, origin_template, origin_version)
        values (loc.org_id, loc.id, v_name, 'pool', private.free_queue_prefix(loc.id),
                coalesce((q ->> 'show_eta')::boolean, true), q ? 'party_max',
                coalesce((q ->> 'party_min')::int, 1), coalesce((q ->> 'party_max')::int, 1), p_template_key, v_version)
        returning * into v_pool;
        result.queues_created := result.queues_created + 1;
      end if;
      v_lines := v_lines || v_pool.id;
    end if;
    foreach v_name in array p_providers loop
      v_name := btrim(v_name);
      select * into v_queue from app.queues x
      where x.location_id = loc.id and x.archived_at is null and x.name = v_name;
      if not found then
        insert into app.queues (org_id, location_id, name, kind, pulls_from, ticket_prefix, show_eta,
                                party_size_enabled, party_size_min, party_size_max, origin_template, origin_version)
        values (loc.org_id, loc.id, v_name, 'provider', v_pool.id, private.free_queue_prefix(loc.id),
                coalesce((q ->> 'show_eta')::boolean, true), q ? 'party_max',
                coalesce((q ->> 'party_min')::int, 1), coalesce((q ->> 'party_max')::int, 1), p_template_key, v_version)
        returning * into v_queue;
        result.queues_created := result.queues_created + 1;
      elsif v_queue.kind = 'provider' and v_queue.pulls_from is null and v_pool.id is not null then
        -- Re-applying with the pool turned on connects the existing personal lines to it.
        update app.queues set pulls_from = v_pool.id where id = v_queue.id;
      end if;
      v_lines := v_lines || v_queue.id;
    end loop;
    foreach v_line in array v_lines loop
      for s in select * from jsonb_array_elements(v_services) loop
        select ts.o_service_id, ts.o_created into v_service, v_created
        from private.template_service(loc, s, tpl, v_mode) ts;
        if v_created then
          result.services_created := result.services_created + 1;
        end if;
        insert into app.queue_services (org_id, location_id, queue_id, service_id, sort_order)
        values (loc.org_id, loc.id, v_line, v_service,
                (select coalesce(max(x.sort_order) + 1, 0) from app.queue_services x where x.queue_id = v_line))
        on conflict do nothing;
      end loop;
    end loop;
  end if;

  for r in select * from jsonb_array_elements(tpl -> 'resources') loop
    if not exists (select 1 from app.counters x
                   where x.location_id = loc.id and x.archived_at is null and x.label = private.catalog_text(r -> 'label')) then
      insert into app.counters (org_id, location_id, label, kind, seats)
      values (loc.org_id, loc.id, private.catalog_text(r -> 'label'), (r ->> 'kind')::app.resource_kind, (r ->> 'seats')::int);
      result.counters_created := result.counters_created + 1;
    end if;
  end loop;

  -- The template's form: one library copy, attached to every line in this one action. Applying again
  -- reuses the copy of the same name. A full library (3 forms), or an agreement before the business has
  -- a privacy contact, leaves the setup without the form (or with it as a draft) rather than failing it.
  if jsonb_typeof(tpl -> 'form') = 'object' then
    v_form_name := left(btrim(private.catalog_text(tpl -> 'form' -> 'name')), 80);
    select * into v_form from app.forms f
    where f.location_id = loc.id and not f.is_queue_default and f.name = v_form_name;
    if not found then
      begin
        perform private.validate_form_fields(private.catalog_form_fields(tpl -> 'form' -> 'fields'));
        insert into app.forms (org_id, location_id, name, origin_template, origin_version)
        values (loc.org_id, loc.id, v_form_name, p_template_key, v_version)
        returning * into v_form;
        insert into app.form_versions (org_id, location_id, form_id, version, fields)
        values (loc.org_id, loc.id, v_form.id, 1, private.catalog_form_fields(tpl -> 'form' -> 'fields'));
      exception when raise_exception then
        v_form := null;
      end;
      if v_form.id is not null then
        begin
          update app.form_versions set published_at = now() where form_id = v_form.id and published_at is null;
          update app.forms set status = 'published' where id = v_form.id;
          v_form.status := 'published';
        exception when raise_exception then
          null; -- stays a draft until the owner records a privacy contact and publishes it
        end;
      end if;
    end if;
    if v_form.status = 'published' then
      insert into app.form_targets (org_id, location_id, form_id, queue_id, channel)
      select loc.org_id, loc.id, v_form.id, l, 'any' from unnest(v_lines) l
      on conflict (queue_id, channel) where queue_id is not null do nothing;
    end if;
  end if;

  perform private.save_idempotent('apply_industry_template', p_idempotency_key, to_jsonb(result));
  return result;
end $function$;

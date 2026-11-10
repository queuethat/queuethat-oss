-- 4-IVR1 (#383): join a queue by phone call (Twilio Voice) with the keypad. The caller ID is the contact;
-- texting needs consent, so the call reads the consent text and records it only when the caller presses 1
-- (source ivr, text version ivr-sms-1). Expand-only.
-- Why a new service-role RPC and not process_inbound_message: a call is a multi-step conversation, not one
-- inbound message; every step is a stateless request (the step and visit ride in the signed webhook URL).
-- Spoofed caller ID: an unverified number must not receive texts a stranger consented to for it, so the
-- text offer (and its consent) needs the carrier's STIR/SHAKEN attestation, checked by the webhook.

do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'app.visits'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''kiosk''%''telegram''%';
  execute format('alter table app.visits drop constraint %I', c);
  alter table app.visits add constraint visits_source_check
    check (source in ('online', 'staff', 'kiosk', 'appointment', 'api', 'sms', 'whatsapp', 'telegram', 'phone'));
end $$;
alter table app.consents drop constraint consents_source_check;
alter table app.consents add constraint consents_source_check
  check (source in ('online', 'staff', 'kiosk', 'inbound', 'import', 'telegram_start', 'wa_keyword', 'ivr'));

-- redefines private.join_core from 20261031023227_wa_join.sql
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
  perform private.bump_queue_version(q.id);
end $$;

-- redefines private.take_join_slot from 20261031024003_telegram_join.sql
create or replace function private.take_join_slot(p_queue app.queues, p_source text, p_device_key text default null)
returns void
language plpgsql volatile set search_path = '' as $$
declare
  -- A person joins one queue a few times at most. Venue Wi-Fi puts many guests behind one IP, and
  -- each phone has its own device key; the network cap stops one client minting device keys.
  per_client_online constant int := 10;
  per_network_online int := (select s.per_network_joins from private.deployment_settings s);
  per_client_window constant interval := interval '10 minutes';
  v_client bytea := private.client_key(p_device_key);
  v_network bytea := private.client_key();
  v_recent int;
  v_queue_recent int;
begin
  -- An API key has its own per-minute budget and is a trusted integration, like staff.
  if p_source in ('staff', 'api') then
    return;
  end if;

  -- A text joins from a verified phone, with no client address or device to count: the queue's own
  -- per-minute and hourly caps are the limit (the V-7 reply cap bounds what each join can cost).
  if p_source in ('sms', 'whatsapp', 'telegram', 'phone') then
    if (select count(*) from app.visits v
        where v.queue_id = p_queue.id and v.source = p_source and v.joined_at > now() - interval '1 minute')
       >= p_queue.join_rate_per_min or app.online_joins_paused_until(p_queue) is not null then
      raise exception 'rate_limited' using detail = 'queue';
    end if;
    -- The hourly ceiling counts online and text joins together, so a text flood cannot dodge it.
    if (select count(*) from app.visits v
        where v.queue_id = p_queue.id and v.source in ('online', 'sms', 'whatsapp', 'telegram', 'phone') and v.joined_at > now() - interval '1 hour')
       >= coalesce(p_queue.online_joins_per_hour, 2147483647) then
      raise exception 'rate_limited' using detail = 'queue_total';
    end if;
    return;
  end if;

  -- Each kiosk gets join_rate_per_min to itself, so online floods never reach the front desk.
  if p_source = 'kiosk' then
    if (select count(*) from private.join_log l
        where l.queue_id = p_queue.id and l.client_key = v_client and l.at > now() - interval '1 minute')
       >= p_queue.join_rate_per_min then
      raise exception 'rate_limited' using detail = 'device';
    end if;
  else
    -- Online: per client (IP and device) first, then per network (IP).
    select count(*) into v_recent from private.join_log l
    where l.queue_id = p_queue.id and l.client_key = v_client and l.at > now() - per_client_window;
    if v_recent >= per_client_online then
      raise exception 'rate_limited' using detail = 'client';
    end if;
    if (select count(*) from private.join_log l
        where l.queue_id = p_queue.id and l.network_key = v_network and l.at > now() - per_client_window)
       >= per_network_online then
      raise exception 'rate_limited' using detail = 'network';
    end if;
    -- Then, while the queue gets more than join_rate_per_min online joins a minute, each client
    -- gets one: anyone who joined in the window waits, but a guest who has not still gets in.
    -- Unknown callers count as having joined. The newcomer exemption stops at three times the
    -- rate, because fresh IPv6 /64s and device keys are cheap.
    select count(*) into v_queue_recent from app.visits v
    where v.queue_id = p_queue.id and v.source = 'online' and v.joined_at > now() - interval '1 minute';
    if v_queue_recent >= 3 * p_queue.join_rate_per_min
       or ((v_client is null or v_recent > 0) and v_queue_recent >= p_queue.join_rate_per_min) then
      raise exception 'rate_limited' using detail = 'queue';
    end if;
    -- Finally the total for the hour, whoever is asking (app.online_joins_paused_until owns the
    -- rule, so the staff banner and this check cannot disagree).
    if app.online_joins_paused_until(p_queue) is not null then
      raise exception 'rate_limited' using detail = 'queue_total';
    end if;
  end if;

  if v_client is not null then
    insert into private.join_log (queue_id, client_key, network_key) values (p_queue.id, v_client, v_network);
  end if;
end $$;

create function api.process_voice_call(p_org_id uuid, p_call_sid text, p_from text, p_step text, p_digits text,
  p_visit_id uuid, p_verified boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_phone text := case when p_from ~ '^\+[1-9][0-9]{6,14}$' then p_from end;
  v_queues uuid[];
  v_multi boolean;
  q app.queues;
  v app.visits;
  v_visit uuid;
  v_contact uuid;
  e record;
  v_join_phone text;
  v_can_text boolean;
begin
  if p_call_sid is null or p_call_sid !~ '^[A-Za-z0-9]{10,64}$' or p_step not in ('menu', 'join', 'consent')
     or coalesce(p_digits, '') !~ '^[0-9*#]{0,2}$' then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;

  -- The numbers the menu reads out: this org's live queues in a fixed order, nine at most (one keypress each).
  select coalesce(array_agg(x.id order by x.ord), '{}'), count(distinct x.location_id) > 1 into v_queues, v_multi
  from (select z.id, z.location_id, row_number() over (order by lo.name, z.created_at, z.id) as ord
        from app.queues z join app.locations lo on lo.id = z.location_id
        where z.org_id = p_org_id and z.archived_at is null) x
  where x.ord <= 9;

  if p_step = 'menu' then
    return jsonb_build_object('handled', 'menu',
      'location', (select case when v_multi then o.name else coalesce((select lo.name from app.locations lo where lo.org_id = o.id limit 1), o.name) end
                   from app.organizations o where o.id = p_org_id),
      'queues', coalesce((select jsonb_agg(case when v_multi then z.name || ' at ' || lo.name else z.name end order by array_position(v_queues, z.id))
                          from app.queues z join app.locations lo on lo.id = z.location_id where z.id = any (v_queues)), '[]'::jsonb));
  end if;

  -- The text offer: a verified caller ID, a number nobody has opted out, and SMS switched on for the org.
  v_can_text := coalesce(p_verified, false) and v_phone is not null and private.channel_enabled(p_org_id, 'sms')
                and not exists (select 1 from app.suppressions s where s.org_id = p_org_id and s.channel = 'sms' and s.value = v_phone);

  if p_step = 'join' then
    -- An unverified caller ID may be anyone's: the call joins anonymously, so it neither finds nor creates
    -- the contact of the number it claims, and learns nothing about that number's place in line.
    v_join_phone := case when coalesce(p_verified, false) then v_phone end;
    if p_digits !~ '^[1-9]$' or p_digits::int > coalesce(array_length(v_queues, 1), 0) then
      return jsonb_build_object('handled', 'invalid');
    end if;
    select * into q from app.queues where id = v_queues[p_digits::int];
    if private.inbound_join_blocked(q) then
      return jsonb_build_object('handled', 'closed');
    end if;
    -- Calling again while still in this line: the same place.
    select * into v from app.visits x
    where x.queue_id = q.id and v_join_phone is not null and x.guest_phone_e164 = v_join_phone
      and x.status in ('expected', 'waiting', 'called', 'serving') order by x.joined_at desc limit 1;
    if not found then
      begin
        select j.visit_id into v_visit from private.join_core(
          q.id, null, 'Caller', v_join_phone, null, 1, null,
          -- Derived from the call and the keypress, so Twilio retrying the request cannot join twice.
          md5('voice-join:' || p_call_sid || ':' || p_digits)::uuid, 'phone', 'guest', null) j;
      exception when others then
        -- Blocked, rate limited or full.
        return jsonb_build_object('handled', 'closed');
      end;
      select * into v from app.visits where id = v_visit;
    end if;
    select * into e from private.visit_eta(v.id);
    return jsonb_build_object('handled', 'joined', 'ticket', v.display_ticket, 'position', private.visit_position(v),
      'eta_low', case when e.eta_state = 'ok' then e.eta_low end, 'eta_high', case when e.eta_state = 'ok' then e.eta_high end,
      'offer_text', v_can_text, 'visit_id', v.id);
  end if;

  -- consent: only the caller's own visit from this call's number, and only the keypress 1.
  select * into v from app.visits x
  where x.id = p_visit_id and x.org_id = p_org_id and x.source = 'phone' and x.guest_phone_e164 = v_phone
    and x.status in ('expected', 'waiting', 'called', 'serving');
  if not found or p_digits <> '1' or not v_can_text then
    return jsonb_build_object('handled', 'bye');
  end if;
  select c.contact_id into v_contact
  from private.ensure_contact(p_org_id, 'phone', v_phone, null, 'Caller', 'online', true) c;
  -- The text read aloud is in the Edge Function (IVR_CONSENT_TEXT); its hash is the evidence.
  insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
  select p_org_id, v_contact, 'sms', 'transactional', 'granted', 'ivr', 'ivr-sms-1',
         encode(sha256(convert_to('Press 1 to get a text message when it is your turn. Message and data rates may apply. Reply STOP to opt out.', 'UTF8')), 'hex')
  where not exists (select 1 from app.consents c where c.contact_id = v_contact and c.channel = 'sms'
                    and c.purpose = 'transactional' and c.status = 'granted' and c.revoked_at is null);
  return jsonb_build_object('handled', 'consent');
end $$;
comment on function api.process_voice_call(uuid, text, text, text, text, uuid, boolean) is
  'Service role only (the Twilio Voice webhook): one step of a keypad call to this org. menu returns the location name and '
  'the queue names (press 1..9); join with the pressed digit joins that queue as source phone (name Caller; the caller ID is the '
  'phone only when the carrier verified it, else the call joins anonymously) and returns the ticket, position, an ETA range when the queue shows one, and offer_text when the caller ID is '
  'carrier-verified, SMS is on and the number has not opted out; consent with digit 1 records transactional SMS consent '
  '(source ivr, text ivr-sms-1) for that visit''s number, nothing otherwise. Handled values: menu, joined, closed (not '
  'accepting, restricted, rate limited or full), invalid, consent, bye. Calling again while in line repeats the place; a '
  'retried request never joins twice. Raises invalid_input for a malformed call sid, step or digits, not_found for an unknown org.';
revoke all on function api.process_voice_call(uuid, text, text, text, text, uuid, boolean) from public, anon, authenticated;
grant execute on function api.process_voice_call(uuid, text, text, text, text, uuid, boolean) to service_role;

notify pgrst, 'reload schema';

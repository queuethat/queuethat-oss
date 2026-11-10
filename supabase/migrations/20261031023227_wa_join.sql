-- 4-BOT1 (#381): join a queue by messaging its keyword on WhatsApp. The guest messages first, which opens the
-- 24 h window and is the opt-in (consent source wa_keyword). The join is the 3-SMS7 keyword join on the
-- message's own channel; updates for that visit go to WhatsApp. Expand-only.
--   * visits.source and consents.source accept whatsapp / wa_keyword.
--   * join_core records the contact of an inbound-channel join, so the visit's updates reach it (they were
--     addressed to the visit, which carries no consent).
--   * A reply to a message the guest just sent needs no prior consent while the window is open.
--   * A phone contact's updates ride WhatsApp when the visit joined there.


do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'app.visits'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''kiosk''%''sms''%';
  execute format('alter table app.visits drop constraint %I', c);
  alter table app.visits add constraint visits_source_check
    check (source in ('online', 'staff', 'kiosk', 'appointment', 'api', 'sms', 'whatsapp'));
end $$;
alter table app.consents drop constraint consents_source_check;
alter table app.consents add constraint consents_source_check
  check (source in ('online', 'staff', 'kiosk', 'inbound', 'import', 'telegram_start', 'wa_keyword'));

insert into app.notification_templates (trigger, channel, body) values
  ('reply_join', 'whatsapp', 'You''re in line at {queue_name}: ticket {ticket}, number {position}. Reply L to leave.'),
  ('reply_join_closed', 'whatsapp', 'Sorry, we''re not taking new people in line right now.');


-- redefines private.join_core from 20261030190828_join_restrictions.sql
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
  if p_source in ('staff', 'sms', 'whatsapp') then
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

-- redefines private.take_join_slot from 20261030222521_sms_join.sql
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
  if p_source in ('sms', 'whatsapp') then
    if (select count(*) from app.visits v
        where v.queue_id = p_queue.id and v.source = p_source and v.joined_at > now() - interval '1 minute')
       >= p_queue.join_rate_per_min or app.online_joins_paused_until(p_queue) is not null then
      raise exception 'rate_limited' using detail = 'queue';
    end if;
    -- The hourly ceiling counts online and text joins together, so a text flood cannot dodge it.
    if (select count(*) from app.visits v
        where v.queue_id = p_queue.id and v.source in ('online', 'sms', 'whatsapp') and v.joined_at > now() - interval '1 hour')
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

-- redefines private.whatsapp_decision from 20261030214737_whatsapp_rules.sql
create or replace function private.whatsapp_decision(
  p_org uuid, p_contact uuid, p_category app.message_category, p_queue uuid, p_locale text, p_template_key text
) returns table (mode text, reason text)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- An answer to what the guest just wrote needs no earlier opt-in: their message opened the window.
  if p_template_key in ('reply_join', 'reply_join_closed') and coalesce((select gc.whatsapp_window_until > now()
                   from app.guest_contacts gc where gc.id = p_contact and gc.org_id = p_org), false) then
    return query select 'session'::text, null::text;
  elsif not coalesce((select c.status = 'granted' and c.revoked_at is null
                   from app.consents c
                   where c.org_id = p_org and c.contact_id = p_contact and c.channel = 'whatsapp' and c.purpose = p_category
                   order by c.captured_at desc limit 1), false) then
    return query select null::text, 'no_consent'::text;
  elsif p_category = 'transactional' and coalesce((select gc.whatsapp_window_until > now()
                   from app.guest_contacts gc where gc.id = p_contact and gc.org_id = p_org), false) then
    return query select 'session'::text, null::text;
  elsif exists (select 1
                from private.resolve_template(p_org, p_queue, p_template_key, 'whatsapp', p_locale) t
                join app.whatsapp_templates w on w.template_id = t.id and w.org_id = p_org
                where w.status = 'approved'
                  and w.wa_category = case p_category when 'transactional' then 'utility' else 'marketing' end) then
    return query select 'template'::text, null::text;
  else
    return query select null::text, 'no_approved_template'::text;
  end if;
end $$;

-- redefines private.visit_recipients from 20261030174915_channel_fallback.sql
create or replace function private.visit_recipients(p_visit app.visits, p_trigger text)
returns table (channel app.notification_channel, ref uuid)
language sql stable set search_path = '' as $$
  select 'push'::app.notification_channel as channel, s.id as ref
    from app.push_subscriptions s
    where s.visit_id = p_visit.id
    union all
    -- A guest who joined on WhatsApp is answered there.
    select case when gc.channel = 'email' then 'email'
                when p_visit.source = 'whatsapp' then 'whatsapp' else 'sms' end::app.notification_channel, gc.id
    from app.guest_contacts gc
    where gc.id = p_visit.contact_id and gc.org_id = p_visit.org_id
    union all
    -- A Telegram chat the guest linked from the status page (#252): its contact is the recipient.
    select 'telegram'::app.notification_channel, l.contact_id
    from app.channel_link_codes l
    where l.visit_id = p_visit.id and l.channel = 'telegram' and l.used_at is not null
      and l.contact_id is not null
    union all
    -- Online and kiosk joins keep what the guest typed on the visit (join_hardening); the visit
    -- itself is the recipient, so recipient_ref is the visit id. The address is unverified, so
    -- only the org's earliest live visit with it is mailed: repeated joins with someone else's
    -- address (or +tag and dot variants of it, canonical_email) send one visit's messages, not one
    -- per join.
    select ch.channel, p_visit.id
    from (values ('email'::app.notification_channel, p_visit.guest_email),
                 ('sms'::app.notification_channel, p_visit.guest_phone_e164)) ch (channel, value)
    where p_visit.contact_id is null and ch.value is not null
      -- Free text from staff never goes to an address a guest only typed (nobody verified it).
      and p_trigger <> 'broadcast'
      and not exists (
        select 1 from app.visits o
        where o.org_id = p_visit.org_id and o.id <> p_visit.id
          and o.status in ('waiting', 'called', 'serving')
          and case ch.channel when 'email' then private.canonical_email(o.guest_email)
                              else o.guest_phone_e164 end
              = case ch.channel when 'email' then private.canonical_email(ch.value) else ch.value end
          and (o.joined_at, o.id) < (p_visit.joined_at, p_visit.id))
$$;
-- A WhatsApp message opens the 24 h session window of its sender's contact; nothing for other channels.
create function private.open_whatsapp_window(m app.inbound_messages, p_contact uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update app.guest_contacts
  set whatsapp_window_until = greatest(coalesce(whatsapp_window_until, '-infinity'), m.received_at + interval '24 hours')
  where m.channel = 'whatsapp' and id = p_contact and org_id = m.org_id
$$;
revoke all on function private.open_whatsapp_window(app.inbound_messages, uuid) from public, anon, authenticated;
comment on function private.open_whatsapp_window(app.inbound_messages, uuid) is
  'Opens the contact''s 24 h WhatsApp session window from a WhatsApp message it sent; a no-op for other channels.';

-- redefines private.apply_inbound_join from 20261030222521_sms_join.sql
create or replace function private.apply_inbound_join(p_inbound_id bigint) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.inbound_messages;
  q app.queues;
  l app.locations;
  v app.visits;
  v_word text;
  v_contact uuid;
  v_visit uuid;
  v_closed boolean;
  t app.notification_templates;
  v_channel text;
begin
  select * into m from app.inbound_messages where id = p_inbound_id;
  if not found then
    raise exception 'not_found';
  end if;
  v_channel := m.channel::text;
  v_word := upper(regexp_replace(m.body, '[^A-Za-z0-9]', '', 'g'));

  -- This org's queue for the word; JOIN alone works when exactly one queue has a keyword.
  select * into q from app.queues
  where org_id = m.org_id and archived_at is null and upper(sms_keyword) = v_word;
  if not found and v_word = 'JOIN' and (select count(*) from app.queues
                                        where org_id = m.org_id and archived_at is null and sms_keyword is not null) = 1 then
    select * into q from app.queues where org_id = m.org_id and archived_at is null and sms_keyword is not null;
  end if;
  if q.id is null then
    return null;
  end if;

  select * into l from app.locations where id = q.location_id;
  -- A venue that wants guests on the premises (geofence, code on the TV) cannot be joined from afar.
  v_closed := private.queue_not_accepting_reason(q.id) is not null
              or q.join_restriction <> 'none' or l.onsite_code_required;

  -- Texting again while still in this line: the same place, and the reply goes out again (J-12).
  if not v_closed then
    select * into v from app.visits x
    where x.queue_id = q.id and x.guest_phone_e164 = m.from_value_e164 and x.status in ('expected', 'waiting', 'called')
    order by x.joined_at desc limit 1;
    if not found then
      begin
        select j.visit_id into v_visit from private.join_core(
          q.id, null, 'Guest', m.from_value_e164, null, 1, null,
          -- Derived from the provider's message id, so a replayed message cannot join twice.
          md5(v_channel || '-join:' || m.provider || ':' || m.provider_message_id)::uuid, v_channel, 'guest', null) j;
        select * into v from app.visits where id = v_visit;
      exception when others then
        -- Blocked, rate limited, full or already in line: the sender hears "closed", the text is kept.
        v_closed := true;
      end;
    end if;
  end if;

  if v_closed then
    -- Each closed reply costs an SMS and a contact row: at most 5 a minute per org.
    if (select count(*) from app.notifications n
        where n.org_id = m.org_id and n.template_key = 'reply_join_closed'
          and n.created_at > now() - interval '1 minute') < 5 then
      select c.contact_id into v_contact
      from private.ensure_contact(m.org_id, 'phone', m.from_value_e164, null, 'Guest', 'online', true) c;
      -- Their message opened the WhatsApp window the reply goes through.
      perform private.open_whatsapp_window(m, v_contact);
      insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key)
      select m.org_id, null, m.channel, v_contact, 'reply_join_closed', t2.version, t2.category,
             'reply_join_closed:' || v_channel || ':' || v_contact || ':' || floor(extract(epoch from now()) / 600)
      from private.resolve_template(m.org_id, q.id, 'reply_join_closed', m.channel, null) t2
      on conflict (dedupe_key) do nothing;
    end if;
    return 'join_closed';
  end if;

  -- The sender proved the number by texting from it, so the contact may be linked to its guest.
  select c.contact_id into v_contact
  from private.ensure_contact(m.org_id, 'phone', m.from_value_e164, null, 'Guest', 'online', true) c;
  perform private.open_whatsapp_window(m, v_contact);
  insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
  select m.org_id, v_contact, m.channel, 'transactional', 'granted',
         case v_channel when 'whatsapp' then 'wa_keyword' else 'inbound' end,
         case v_channel when 'whatsapp' then 'wa-join-1' else 'sms-join-1' end,
         encode(sha256(convert_to('inbound join keyword text', 'UTF8')), 'hex')
  where not exists (select 1 from app.consents c where c.contact_id = v_contact and c.channel = m.channel
                    and c.purpose = 'transactional' and c.status = 'granted' and c.revoked_at is null);

  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category,
                                 dedupe_key, vars)
  select m.org_id, v.id, m.channel, v_contact, 'reply_join', t2.version, t2.category,
         'reply_join:' || v_channel || ':' || v.id || ':' || floor(extract(epoch from now()) / 600),
         jsonb_build_object('ticket', v.display_ticket, 'queue_name', q.name, 'position', private.visit_position(v))
  from private.resolve_template(m.org_id, q.id, 'reply_join', m.channel, v.locale) t2
  on conflict (dedupe_key) do nothing;
  return 'join';
end $$;
comment on function private.apply_inbound_join(bigint) is
  'A whole-message queue keyword (or JOIN with exactly one keyword queue) from the org''s own number '
  'joins that queue as source sms or whatsapp (the message''s channel), records the message as '
  'transactional consent on that channel (source inbound, or wa_keyword) and queues the ticket reply. '
  'Still in line: no second visit, the reply repeats. Queue closed or on-premises only: a closed reply and '
  'no visit. Returns join, join_closed, or null when the text is no join keyword.';

-- redefines api.process_inbound_message from 20261030222521_sms_join.sql
create or replace function api.process_inbound_message(p_org_id uuid, p_channel text, p_from text, p_to text,
  p_body text, p_provider text, p_provider_message_id text) returns api.inbound_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.inbound_messages;
  v_body text := btrim(coalesce(p_body, ''));
  v_handled text;
  v_visit uuid;
begin
  if p_channel is null or p_channel not in ('sms', 'whatsapp') or p_from is null or p_from !~ '^\+[1-9][0-9]{6,14}$'
     or length(v_body) not between 1 and 1600 or coalesce(p_provider, '') = '' or coalesce(p_provider_message_id, '') = '' then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;

  select * into m from app.inbound_messages
  where org_id = p_org_id and provider = p_provider and provider_message_id = p_provider_message_id;
  if found then
    -- A replay: the first answer stands.
    return row(m.public_id, m.handled_as, m.matched_contact_id, m.visit_id)::api.inbound_result;
  end if;

  insert into app.inbound_messages (org_id, channel, from_value_e164, to_address, body, provider, provider_message_id,
                                    signature_verified, matched_contact_id)
  values (p_org_id, p_channel::app.notification_channel, p_from, p_to, v_body, p_provider, p_provider_message_id, true,
          (select gc.id from app.guest_contacts gc
           where gc.org_id = p_org_id and gc.channel = 'phone' and gc.value = p_from))
  on conflict (provider, provider_message_id) where provider is not null do nothing
  returning * into m;
  if not found then
    select * into m from app.inbound_messages
    where org_id = p_org_id and provider = p_provider and provider_message_id = p_provider_message_id;
    return row(m.public_id, m.handled_as, m.matched_contact_id, m.visit_id)::api.inbound_result;
  end if;

  -- A WhatsApp reply opens the 24 h customer service window (free-text session messages).
  if m.channel = 'whatsapp' and m.matched_contact_id is not null then
    update app.guest_contacts
    set whatsapp_window_until = greatest(coalesce(whatsapp_window_until, '-infinity'), m.received_at + interval '24 hours')
    where id = m.matched_contact_id and org_id = p_org_id;
  end if;
  v_handled := private.apply_inbound_keyword(m.id);
  if v_handled = 'stored' then
    -- Not a carrier keyword: a queue's join keyword, else (SMS only, the replies are SMS templates) a
    -- two-way command (C / L), else left for staff.
    v_handled := coalesce(private.apply_inbound_join(m.id),
                          case when m.channel = 'sms' then private.apply_inbound_command(m.id) else 'unhandled' end);
  end if;
  select x.id into v_visit from app.visits x
  where x.org_id = p_org_id and x.status in ('expected', 'waiting', 'called', 'serving')
    and (x.contact_id = m.matched_contact_id or (x.contact_id is null and x.guest_phone_e164 = p_from))
    and (m.matched_contact_id is not null or x.contact_id is null)
  order by x.joined_at desc, x.id limit 1;
  update app.inbound_messages set handled_as = v_handled, visit_id = v_visit where id = m.id
  returning * into m;
  return row(m.public_id, m.handled_as, m.matched_contact_id, m.visit_id)::api.inbound_result;
end $$;
comment on function api.process_inbound_message(uuid, text, text, text, text, text, text) is
  'Service role only (provider-webhook): stores an inbound SMS or WhatsApp message once per (provider, message id) and '
  'applies it in the same call: a carrier keyword (stop, start, help), else a queue''s join keyword, else (SMS only) a '
  'two-way command (confirm, leave), else unhandled; a WhatsApp message from a known contact also opens its 24 h window. '
  'A replay returns the first result. Raises invalid_input for a channel other than sms or whatsapp, bad sender, empty or '
  'oversized body, not_found for an unknown org. Implemented in 3-CG8 (#333), commands in 3-SMS6 (#355), join in 3-SMS7 '
  '(#356), WhatsApp in 3-WA3 (#360), WhatsApp join in 4-BOT1 (#381).';

notify pgrst, 'reload schema';

-- 3-SMS7 (#356): join a queue by texting its keyword. Expand-only.
-- The text itself is the guest's consent (source inbound, versioned text 'sms-join-1'); the join goes
-- through private.join_core like every other source, so the accepting predicate (I-8), blocks and
-- capacity apply unchanged.

alter table app.queues add column sms_keyword text;
-- Not a carrier keyword or command word, and 2-20 letters or digits.
create function private.valid_sms_keyword(p_keyword text) returns boolean
language sql immutable set search_path = '' as $$
  select p_keyword ~ '^[A-Za-z0-9]{2,20}$'
     and private.inbound_keyword_kind(p_keyword) is null
     and private.inbound_command_kind(p_keyword) is null
     and upper(p_keyword) <> 'JOIN'
$$;
comment on function private.valid_sms_keyword(text) is
  '2 to 20 letters or digits that are no carrier keyword (STOP, HELP, START...), no command word (C, L...) and not JOIN.';
-- The CHECK runs as whoever edits the queue, so the pure word-list helpers it calls are executable by all.
grant execute on function private.valid_sms_keyword(text), private.inbound_keyword_kind(text),
  private.inbound_command_kind(text) to public;
alter table app.queues add constraint queues_sms_keyword_check
  check (sms_keyword is null or private.valid_sms_keyword(sms_keyword));
create unique index queues_sms_keyword_idx on app.queues (org_id, upper(sms_keyword)) where sms_keyword is not null;

do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'app.visits'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''kiosk''%''appointment''%';
  execute format('alter table app.visits drop constraint %I', c);
  alter table app.visits add constraint visits_source_check
    check (source in ('online', 'staff', 'kiosk', 'appointment', 'api', 'sms'));
end $$;

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed'));
insert into app.notification_templates (trigger, channel, body) values
  ('reply_join', 'sms', 'You''re in line at {queue_name}: ticket {ticket}, number {position}. Reply L to leave.'),
  ('reply_join_closed', 'sms', 'Sorry, we''re not taking new people in line right now.');

-- redefines private.template_variables from 20261030220519_sms_commands.sql
create or replace function private.template_variables(p_trigger text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p_trigger = 'broadcast' then array['ticket', 'eta_range']
    when p_trigger = 'help' then array['business_name', 'support_contact']
    when p_trigger = 'reply_join' then array['ticket', 'position', 'queue_name']
    when p_trigger like 'reply\_%' then array[]::text[]
    when p_trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'removed', 'served',
                       'joined', 'no_show_warning') then
      array['guest_first_name', 'ticket', 'queue_name', 'location_name', 'counter', 'eta_range',
            'status_link', 'appointment_time', 'business_phone', 'unsubscribe_url', 'position']
  end
$$;

-- redefines private.take_join_slot from 20261030173220_api_v1_write.sql
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
  if p_source = 'sms' then
    if (select count(*) from app.visits v
        where v.queue_id = p_queue.id and v.source = 'sms' and v.joined_at > now() - interval '1 minute')
       >= p_queue.join_rate_per_min or app.online_joins_paused_until(p_queue) is not null then
      raise exception 'rate_limited' using detail = 'queue';
    end if;
    -- The hourly ceiling counts online and text joins together, so a text flood cannot dodge it.
    if (select count(*) from app.visits v
        where v.queue_id = p_queue.id and v.source in ('online', 'sms') and v.joined_at > now() - interval '1 hour')
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

create function private.apply_inbound_join(p_inbound_id bigint) returns text
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
begin
  select * into m from app.inbound_messages where id = p_inbound_id;
  if not found then
    raise exception 'not_found';
  end if;
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
          md5('sms-join:' || m.provider || ':' || m.provider_message_id)::uuid, 'sms', 'guest', null) j;
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
      insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key)
      select m.org_id, null, 'sms', v_contact, 'reply_join_closed', t2.version, t2.category,
             'reply_join_closed:' || v_contact || ':' || floor(extract(epoch from now()) / 600)
      from private.resolve_template(m.org_id, q.id, 'reply_join_closed', 'sms', null) t2
      on conflict (dedupe_key) do nothing;
    end if;
    return 'join_closed';
  end if;

  -- The sender proved the number by texting from it, so the contact may be linked to its guest.
  select c.contact_id into v_contact
  from private.ensure_contact(m.org_id, 'phone', m.from_value_e164, null, 'Guest', 'online', true) c;
  insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
  select m.org_id, v_contact, 'sms', 'transactional', 'granted', 'inbound', 'sms-join-1',
         encode(sha256(convert_to('inbound join keyword text', 'UTF8')), 'hex')
  where not exists (select 1 from app.consents c where c.contact_id = v_contact and c.channel = 'sms'
                    and c.purpose = 'transactional' and c.status = 'granted' and c.revoked_at is null);

  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category,
                                 dedupe_key, vars)
  select m.org_id, v.id, 'sms', v_contact, 'reply_join', t2.version, t2.category,
         'reply_join:' || v.id || ':' || floor(extract(epoch from now()) / 600),
         jsonb_build_object('ticket', v.display_ticket, 'queue_name', q.name, 'position', private.visit_position(v))
  from private.resolve_template(m.org_id, q.id, 'reply_join', 'sms', v.locale) t2
  on conflict (dedupe_key) do nothing;
  return 'join';
end $$;
comment on function private.apply_inbound_join(bigint) is
  'A whole-message queue keyword (or JOIN with exactly one keyword queue) from the org''s own number '
  'joins that queue as source sms, records the text as transactional SMS consent and queues the '
  'ticket reply. Still in line: no second visit, the reply repeats. Queue closed or on-premises only: '
  'a closed reply and no visit. Returns join, join_closed, or null when the text is no join keyword.';
revoke all on function private.apply_inbound_join(bigint) from public, anon, authenticated;

-- redefines api.process_inbound_message from 20261030221820_whatsapp_inbound.sql
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
  if v_handled = 'stored' and m.channel = 'sms' then
    -- Not a carrier keyword: a queue's join keyword, else a two-way command (C / L), else left for
    -- staff. The replies are SMS templates, so WhatsApp waits for its own (#355, 4-BOT1).
    v_handled := coalesce(private.apply_inbound_join(m.id), private.apply_inbound_command(m.id));
  elsif v_handled = 'stored' then
    v_handled := 'unhandled';
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
  'applies it in the same call: a carrier keyword (stop, start, help), else (SMS only) a two-way command '
  '(confirm, leave), else unhandled; a WhatsApp message from a known contact also opens its 24 h window. A replay returns the first result. Raises invalid_input for a '
  'channel other than sms or whatsapp, bad sender, empty or oversized body, not_found for an unknown org. Implemented in '
  '3-CG8 (#333), commands in 3-SMS6 (#355), join in 3-SMS7 (#356), WhatsApp in 3-WA3 (#360).';

alter table app.inbound_messages drop constraint inbound_messages_handled_as_check;
alter table app.inbound_messages add constraint inbound_messages_handled_as_check
  check (handled_as in ('stop', 'start', 'help', 'confirm', 'leave', 'join', 'join_closed', 'unhandled', 'stored'));

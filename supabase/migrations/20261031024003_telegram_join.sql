-- 4-BOT2 (#382): join a queue from Telegram. /start <location slug>[_<queue keyword>] (the poster's t.me deep link)
-- joins, /leave leaves. The deployment's one bot serves every org, so the slug names the org; the chat id
-- is the guest's contact and /start is its consent (source telegram_start). Expand-only.
-- Why a new service-role RPC and not process_inbound_message: that one takes the org from a per-org webhook
-- endpoint; the shared bot has none, so this function resolves it from the slug, then reuses join_core.

do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'app.visits'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''kiosk''%''whatsapp''%';
  execute format('alter table app.visits drop constraint %I', c);
  alter table app.visits add constraint visits_source_check
    check (source in ('online', 'staff', 'kiosk', 'appointment', 'api', 'sms', 'whatsapp', 'telegram'));
end $$;

/** The refusals shared by every inbound-channel join: not accepting, or a venue that wants guests on the premises. */
create function private.inbound_join_blocked(q app.queues) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.queue_not_accepting_reason(q.id) is not null or q.join_restriction <> 'none'
         or coalesce((select l.onsite_code_required from app.locations l where l.id = q.location_id), false)
$$;
revoke all on function private.inbound_join_blocked(app.queues) from public, anon, authenticated;
comment on function private.inbound_join_blocked(app.queues) is
  'True when a join from a messaging channel must be refused: the queue is not accepting, restricts joins, or the location needs a code shown on site.';

-- redefines private.apply_inbound_join from 20261031023227_wa_join.sql
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
  v_closed := private.inbound_join_blocked(q);

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

-- redefines private.take_join_slot from 20261031023227_wa_join.sql
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
  if p_source in ('sms', 'whatsapp', 'telegram') then
    if (select count(*) from app.visits v
        where v.queue_id = p_queue.id and v.source = p_source and v.joined_at > now() - interval '1 minute')
       >= p_queue.join_rate_per_min or app.online_joins_paused_until(p_queue) is not null then
      raise exception 'rate_limited' using detail = 'queue';
    end if;
    -- The hourly ceiling counts online and text joins together, so a text flood cannot dodge it.
    if (select count(*) from app.visits v
        where v.queue_id = p_queue.id and v.source in ('online', 'sms', 'whatsapp', 'telegram') and v.joined_at > now() - interval '1 hour')
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

create function api.process_telegram_message(p_chat_id text, p_update_id text, p_text text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  v_value text := 'tg:' || p_chat_id;
  v_payload text;
  v_slug text;
  v_word text;
  v_loc uuid;
  v_org uuid;
  q app.queues;
  v app.visits;
  v_n int;
  v_contact uuid;
  v_visit uuid;
begin
  if p_chat_id is null or p_chat_id !~ '^-?[0-9]{1,20}$' or p_update_id is null or p_update_id !~ '^[0-9]{1,20}$'
     or length(v_text) > 300 then
    raise exception 'invalid_input';
  end if;

  if v_text ~* '^/leave(@[a-z0-9_]+)?$' then
    -- The chat's live places, in every org; one place is cancelled, several are ambiguous and left alone (J-15).
    select count(*) into v_n from app.visits x
    where x.status in ('waiting', 'called', 'expected') and exists (
      select 1 from app.channel_link_codes l join app.guest_contacts gc on gc.id = l.contact_id and gc.org_id = l.org_id
      where l.visit_id = x.id and l.used_at is not null and gc.channel = 'telegram' and gc.value = v_value);
    if v_n <> 1 then
      return jsonb_build_object('handled', case when v_n = 0 then 'unhandled' else 'multiple' end);
    end if;
    select x.* into v from app.visits x
    where x.status in ('waiting', 'called', 'expected') and exists (
      select 1 from app.channel_link_codes l join app.guest_contacts gc on gc.id = l.contact_id and gc.org_id = l.org_id
      where l.visit_id = x.id and l.used_at is not null and gc.channel = 'telegram' and gc.value = v_value);
    -- Queue row before visit row, the order every reorder uses, so this cannot deadlock with call_next.
    perform 1 from app.queues where id = v.queue_id for update;
    select x.* into v from app.visits x where x.id = v.id and x.status in ('waiting', 'called', 'expected') for update;
    if not found then
      return jsonb_build_object('handled', 'unhandled');
    end if;
    perform private.set_actor('guest', null, 'cancel', null, jsonb_build_object('source', 'telegram'));
    update app.visits set status = 'cancelled', finished_at = now() where id = v.id;
    perform private.bump_queue_version(v.queue_id);
    return jsonb_build_object('handled', 'leave');
  end if;

  v_payload := substring(v_text from '(?i)^/start(?:@[a-z0-9_]+)?\s+([A-Za-z0-9_-]{1,100})$');
  if v_payload is null then
    return jsonb_build_object('handled', 'unhandled');
  end if;
  v_slug := lower(split_part(v_payload, '_', 1));
  v_word := upper(nullif(split_part(v_payload, '_', 2), ''));

  -- A printed poster keeps working after a rename (I-10), so old slugs resolve too.
  select l.id, l.org_id into v_loc, v_org from app.locations l where l.slug = v_slug;
  if v_loc is null then
    select r.location_id, r.org_id into v_loc, v_org from app.slug_redirects r where r.old_slug = v_slug;
  end if;
  if v_loc is null then
    return jsonb_build_object('handled', 'unknown');
  end if;

  if v_word is not null then
    select * into q from app.queues
    where location_id = v_loc and archived_at is null and upper(sms_keyword) = v_word;
  elsif (select count(*) from app.queues where location_id = v_loc and archived_at is null) = 1 then
    select * into q from app.queues where location_id = v_loc and archived_at is null;
  else
    return jsonb_build_object('handled', 'choose');
  end if;
  if q.id is null then
    return jsonb_build_object('handled', 'unknown');
  end if;
  if private.inbound_join_blocked(q) then
    return jsonb_build_object('handled', 'join_closed');
  end if;

  -- Starting again while still in this line: the same place, the reply repeats.
  select x.* into v from app.visits x
  where x.queue_id = q.id and x.status in ('expected', 'waiting', 'called', 'serving') and exists (
    select 1 from app.channel_link_codes l join app.guest_contacts gc on gc.id = l.contact_id and gc.org_id = l.org_id
    where l.visit_id = x.id and l.used_at is not null and gc.channel = 'telegram' and gc.value = v_value)
  order by x.joined_at desc limit 1;
  if not found then
    -- Telegram accounts are cheap and carry no phone or device for the block list or the per-contact
    -- cap, so the chat gets its own: five joins an hour, however it leaves and starts again.
    if (select count(*) from app.visits x where x.source = 'telegram' and x.joined_at > now() - interval '1 hour'
        and exists (select 1 from app.channel_link_codes l join app.guest_contacts gc on gc.id = l.contact_id and gc.org_id = l.org_id
                    where l.visit_id = x.id and gc.channel = 'telegram' and gc.value = v_value)) >= 5 then
      return jsonb_build_object('handled', 'join_closed');
    end if;
    begin
      select j.visit_id into v_visit from private.join_core(
        q.id, null, 'Guest', null, null, 1, null,
        -- Derived from Telegram's update id, so a retried update cannot join twice.
        md5('telegram-join:' || p_update_id)::uuid, 'telegram', 'guest', null) j;
    exception when others then
      -- Blocked, rate limited or full: the sender hears "closed".
      return jsonb_build_object('handled', 'join_closed');
    end;
    select * into v from app.visits where id = v_visit;
    -- A retried /start after /leave finds its old, cancelled visit: nothing to link or announce.
    if v.status not in ('expected', 'waiting', 'called', 'serving') then
      return jsonb_build_object('handled', 'unhandled');
    end if;
  end if;

  -- The chat is the guest's contact and /start is its opt-in, like a link from the status page.
  select c.contact_id into v_contact
  from private.ensure_contact(v.org_id, 'telegram', v_value, null, 'Guest', 'online', true) c;
  delete from app.suppressions where org_id = v.org_id and channel = 'telegram' and value = v_value and reason = 'stop';
  insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
  select v.org_id, v_contact, 'telegram', 'transactional', 'granted', 'telegram_start', 'telegram_start_v1',
         encode(extensions.digest('telegram_start_v1', 'sha256'), 'hex')
  where not exists (select 1 from app.consents c where c.contact_id = v_contact and c.channel = 'telegram'
                    and c.purpose = 'transactional' and c.status = 'granted' and c.revoked_at is null);
  -- An already-used link row is how updates find a chat (private.visit_recipients).
  insert into app.channel_link_codes (code_hash, org_id, visit_id, channel, expires_at, used_at, contact_id)
  select extensions.digest(extensions.gen_random_bytes(18), 'sha256'), v.org_id, v.id, 'telegram', now(), now(), v_contact
  where not exists (select 1 from app.channel_link_codes l where l.visit_id = v.id and l.contact_id = v_contact
                    and l.used_at is not null);
  return jsonb_build_object('handled', 'join', 'ticket', v.display_ticket, 'position', private.visit_position(v),
                            'queue_name', q.name);
end $$;
comment on function api.process_telegram_message(text, text, text) is
  'Service role only (the Telegram webhook): /start <location slug>[_<queue keyword>] joins the location''s queue as source '
  'telegram (the only queue, or the one with that keyword), links the chat as a telegram contact with transactional '
  'consent (source telegram_start) and returns {handled: join, ticket, position, queue_name}; starting again while in line '
  'repeats the place. /leave cancels the chat''s single live place. handled is also join_closed (queue not accepting, '
  'restricted, rate limited or full), unknown (no such location or queue), choose (several queues, no keyword), multiple, '
  'unhandled. Raises invalid_input for a malformed chat or update id. A retried update_id never joins twice.';
revoke all on function api.process_telegram_message(text, text, text) from public, anon, authenticated;
grant execute on function api.process_telegram_message(text, text, text) to service_role;

notify pgrst, 'reload schema';

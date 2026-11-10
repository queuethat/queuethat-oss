-- N-3 (#252): link a guest's Telegram chat to their visit with a single-use code, no typing.
-- Clients never touch the table; the codes are stored hashed (sha256) like guest tokens.

create table app.channel_link_codes (
  code_hash bytea primary key,
  org_id uuid not null,
  visit_id uuid not null,
  channel text not null check (channel = 'telegram'),
  expires_at timestamptz not null,
  used_at timestamptz,
  contact_id uuid,
  created_at timestamptz not null default now(),
  foreign key (org_id, visit_id) references app.visits (org_id, id),
  foreign key (org_id, contact_id) references app.guest_contacts (org_id, id) on delete cascade
);
create index channel_link_codes_visit_idx on app.channel_link_codes (visit_id);
alter table app.channel_link_codes enable row level security;
revoke all on app.channel_link_codes from anon, authenticated;
-- No client policy lets a row through; the link flow runs in definer functions.
create policy channel_link_codes_none on app.channel_link_codes for select to authenticated using (false);

-- A telegram contact's value is `tg:<chat_id>`; its consent evidence is the /start the chat sent.
alter table app.guest_contacts add constraint guest_contacts_telegram_check
  check (channel <> 'telegram' or value ~ '^tg:-?[0-9]{1,20}$');
alter table app.consents drop constraint consents_source_check;
alter table app.consents add constraint consents_source_check
  check (source in ('online', 'staff', 'kiosk', 'inbound', 'import', 'telegram_start'));

-- Telegram says what push says: same plain text, no markup.
insert into app.notification_templates (trigger, channel, locale, category, subject, body)
select t.trigger, 'telegram', t.locale, t.category, t.subject, t.body
from app.notification_templates t
where t.channel = 'push' and t.org_id is null and t.queue_id is null
on conflict do nothing;

-- redefines api.guest_create_link_code from 20261030162713_api_contracts_2b.sql
create or replace function api.guest_create_link_code(p_token text, p_channel text) returns api.link_code
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_bot text;
  v_code text := translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_');
  v_expires timestamptz := now() + interval '15 minutes';
begin
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input';
  end if;
  v := private.visit_by_token(p_token);
  select s.decrypted_secret into v_bot from vault.decrypted_secrets s where s.name = 'telegram_bot_username';
  if p_channel is distinct from 'telegram' or v_bot is null or v_bot !~ '^[A-Za-z0-9_]{5,32}$' then
    raise exception 'invalid_input';
  end if;
  delete from app.channel_link_codes where visit_id = v.id and used_at is null and expires_at < now();
  -- A token holder can mint a few codes, not a table full of them: keep the newest five unused.
  delete from app.channel_link_codes c
  where c.visit_id = v.id and c.used_at is null and c.code_hash not in (
    select k.code_hash from app.channel_link_codes k where k.visit_id = v.id and k.used_at is null
    order by k.created_at desc limit 4);
  insert into app.channel_link_codes (code_hash, org_id, visit_id, channel, expires_at)
  values (extensions.digest(v_code, 'sha256'), v.org_id, v.id, 'telegram', v_expires);
  return row('https://t.me/' || v_bot || '?start=' || v_code, v_expires)::api.link_code;
end $$;
comment on function api.guest_create_link_code(text, text) is
  'Creates a single-use code, valid 15 minutes and stored hashed, and the t.me deep link that ties '
  'the token''s visit to a Telegram chat; a visit keeps its five newest unused codes. Raises '
  'not_found as get_visit_status does, invalid_input for a channel other than telegram or when no '
  'bot is configured (vault secret telegram_bot_username). POST only. Implemented in N2 (#252).';

-- redefines api.redeem_link_code from 20261030162713_api_contracts_2b.sql
create or replace function api.redeem_link_code(p_code text, p_chat_id text) returns api.link_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  c app.channel_link_codes;
  v app.visits;
  v_guest uuid;
  v_contact uuid;
  v_value text := 'tg:' || p_chat_id;
begin
  if p_chat_id is null or p_chat_id !~ '^-?[0-9]{1,20}$' then
    return row(false, null)::api.link_result;
  end if;
  select * into c from app.channel_link_codes
  where code_hash = extensions.digest(coalesce(p_code, ''), 'sha256') for update;
  if not found or c.used_at is not null or c.expires_at < now() then
    return row(false, null)::api.link_result;
  end if;
  select * into v from app.visits where id = c.visit_id and org_id = c.org_id;

  select gc.id into v_contact from app.guest_contacts gc
  where gc.org_id = c.org_id and gc.channel = 'telegram' and gc.value = v_value;
  if v_contact is null then
    v_guest := v.guest_id;
    if v_guest is null then
      insert into app.guests (org_id, first_name) values (c.org_id, left(v.guest_name, 60)) returning id into v_guest;
    end if;
    insert into app.guest_contacts (org_id, guest_id, channel, value, verified_at, created_source)
    values (c.org_id, v_guest, 'telegram', v_value, now(), 'online') returning id into v_contact;
  end if;

  insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
  values (c.org_id, v_contact, 'telegram', 'transactional', 'granted', 'telegram_start', 'telegram_start_v1',
          encode(extensions.digest('telegram_start_v1', 'sha256'), 'hex'));
  -- Sending /start again is an explicit new opt-in after a /stop.
  delete from app.suppressions where org_id = c.org_id and channel = 'telegram' and value = v_value and reason = 'stop';
  update app.channel_link_codes set used_at = now(), contact_id = v_contact where code_hash = c.code_hash;
  return row(true, c.visit_id)::api.link_result;
end $$;
comment on function api.redeem_link_code(text, text) is
  'Service role only (the Telegram webhook Edge Function): binds the chat to the code''s visit, '
  'creating the telegram contact and a transactional consent with source telegram_start, all in '
  'the code''s org. A used, expired, unknown or malformed code (or chat id) returns linked = false '
  'and changes nothing. Implemented in N2 (#252).';
revoke all on function api.redeem_link_code(text, text) from public, anon, authenticated;
grant execute on function api.redeem_link_code(text, text) to service_role;

-- Why a new function: /stop has no code, and the webhook must not write consents or suppressions
-- itself (rule 5: invariants live in definer functions).
create function api.unlink_telegram_chat(p_chat_id text) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n int;
begin
  if p_chat_id is null or p_chat_id !~ '^-?[0-9]{1,20}$' then
    return 0;
  end if;
  update app.consents set status = 'revoked', revoked_at = now(), revoked_via = 'telegram_stop'
  where channel = 'telegram' and status = 'granted' and revoked_at is null
    and contact_id in (select gc.id from app.guest_contacts gc where gc.channel = 'telegram' and gc.value = 'tg:' || p_chat_id);
  get diagnostics v_n = row_count;
  insert into app.suppressions (org_id, channel, value, reason)
  select gc.org_id, 'telegram', gc.value, 'stop' from app.guest_contacts gc
  where gc.channel = 'telegram' and gc.value = 'tg:' || p_chat_id
  on conflict (org_id, channel, value) do nothing;
  return v_n;
end $$;
comment on function api.unlink_telegram_chat(text) is
  'Service role only (the Telegram webhook, on /stop): revokes the chat''s telegram consents and '
  'suppresses it, in every org that has it as a contact. Returns the consents revoked; repeating it '
  'returns 0. Implemented in N2 (#252).';
revoke all on function api.unlink_telegram_chat(text) from public, anon, authenticated;
grant execute on function api.unlink_telegram_chat(text) to service_role;

-- redefines private.enqueue_notification from 20261030101501_expected_visits.sql
create or replace function private.enqueue_notification(
  p_visit app.visits,
  p_event_id bigint,
  p_trigger text,
  p_scope text,
  p_vars jsonb default '{}'
) returns void
language sql volatile set search_path = '' as $$
  insert into app.notifications (org_id, visit_id, event_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select p_visit.org_id, p_visit.id, p_event_id, r.channel, r.ref, p_trigger, t.version, t.category,
         jsonb_strip_nulls(jsonb_build_object('ticket', p_visit.display_ticket, 'counter', c.label)
                           || coalesce(p_vars, '{}')),
         concat_ws(':', p_scope, r.channel, r.ref)
  from (
    select 'push'::app.notification_channel as channel, s.id as ref
    from app.push_subscriptions s
    where s.visit_id = p_visit.id
    union all
    select case gc.channel when 'email' then 'email' else 'sms' end::app.notification_channel, gc.id
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
  ) r
  cross join lateral private.resolve_template(p_visit.org_id, p_visit.queue_id, p_trigger,
                                              r.channel, p_visit.locale) t
  left join app.counters c on c.id = p_visit.counter_id
  -- The guest's alert choice: a trigger they switched off is never queued.
  where p_trigger = any (private.visit_alert_triggers(p_visit.id))
  on conflict (dedupe_key) do nothing
$$;

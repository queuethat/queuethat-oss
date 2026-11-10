-- #986: a guest proves their phone with a one-time SMS code. Two anon RPCs on the visit token (alternatives
-- in the issue: a code param on guest_act changes a Phase-0 signature; verify-by-inbound-reply cannot be
-- routed from a shared number). The code is never stored: only an HMAC (Vault guest_token_secret) bound to the
-- visit (the queued SMS holds the plaintext only until it is sent), with a 10 minute expiry, 5 tries, 3 sends per visit per hour and a 30 s resend gap. Limits per visit,
-- device, network and number are counted before anything about the number is looked at. A number the org
-- already holds (or has opted out) gets the same answers as any other, but no code is sent and none can match.
-- Success sets guest_contacts.verified_at, which the CRM/POS sync and "joined" mail already read.

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify'));
insert into app.notification_templates (trigger, channel, body) values
  ('reply_verify', 'sms', 'QueueThat: your code is {code}. It expires in 10 minutes. Reply STOP to opt out.');

-- redefines private.template_variables from 20261030222521_sms_join.sql
create or replace function private.template_variables(p_trigger text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p_trigger = 'broadcast' then array['ticket', 'eta_range']
    when p_trigger = 'help' then array['business_name', 'support_contact']
    when p_trigger = 'reply_join' then array['ticket', 'position', 'queue_name']
    when p_trigger = 'reply_verify' then array['code']
    when p_trigger like 'reply\_%' then array[]::text[]
    when p_trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'removed', 'served',
                       'joined', 'no_show_warning') then
      array['guest_first_name', 'ticket', 'queue_name', 'location_name', 'counter', 'eta_range',
            'status_link', 'appointment_time', 'business_phone', 'unsubscribe_url', 'position']
  end
$$;

create table private.phone_codes (
  visit_id uuid primary key references app.visits (id) on delete cascade,
  -- null when the number is one the org holds: a row still exists so the answers are the same
  contact_id uuid,
  code_hash bytea not null,
  expires_at timestamptz not null,
  tries int not null default 0,
  sends int not null default 0,
  last_sent_at timestamptz not null default now()
);
revoke all on private.phone_codes from public, anon, authenticated;

create table private.phone_code_attempts (
  visit_id uuid not null,
  kind text not null check (kind in ('request', 'verify')),
  ip_hash bytea,
  device_hash bytea,
  phone_hash bytea,
  at timestamptz not null default now()
);
create index phone_code_attempts_visit_idx on private.phone_code_attempts (visit_id, kind, at);
create index phone_code_attempts_ip_idx on private.phone_code_attempts (ip_hash, at) where ip_hash is not null;
create index phone_code_attempts_device_idx on private.phone_code_attempts (device_hash, at) where device_hash is not null;
create index phone_code_attempts_phone_idx on private.phone_code_attempts (phone_hash, at) where phone_hash is not null;
revoke all on private.phone_code_attempts from public, anon, authenticated;

create type api.phone_verification as (
  -- sent: a code was sent (or is still valid); verified: the number is verified; invalid: the code did not match
  state text,
  -- earliest time another code may be requested
  resend_after timestamptz
);

create function private.phone_code_hash(p_visit_id uuid, p_code text) returns bytea
language sql stable security definer set search_path = '' as $$
  select extensions.hmac(convert_to(p_visit_id::text || ':' || p_code, 'UTF8'),
                         (select decode(s.decrypted_secret, 'base64') from vault.decrypted_secrets s where s.name = 'guest_token_secret'),
                         'sha256')
$$;
revoke all on function private.phone_code_hash(uuid, text) from public, anon, authenticated;

-- The code must not outlive its message in a table staff can read: once the row is final its vars are emptied.
create function private.scrub_verify_code() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.template_key = 'reply_verify' and new.status::text in ('sent', 'suppressed', 'dead') then
    new.vars := '{}';
  end if;
  return new;
end $$;
revoke all on function private.scrub_verify_code() from public, anon, authenticated;
create trigger scrub_verify_code before update on app.notifications
  for each row when (new.template_key = 'reply_verify') execute function private.scrub_verify_code();

create function api.guest_request_phone_code(p_token text) returns api.phone_verification
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  c app.guest_contacts;
  v_phone text;
  v_ip bytea;
  v_phone_hash bytea;
  v_code text;
  t app.notification_templates;
  r private.phone_codes;
  v_real boolean;
begin
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  v := private.visit_by_token(p_token, true);
  if v.status not in ('expected', 'waiting', 'called', 'serving') then
    raise exception 'not_found';
  end if;
  select * into c from app.guest_contacts gc where gc.org_id = v.org_id and gc.id = v.contact_id and gc.channel = 'phone';
  v_phone := coalesce(c.value, v.guest_phone_e164);
  if v_phone is null then
    raise exception 'invalid_input';
  end if;

  -- Limits first; the attempt is recorded before anything depends on the number. Per visit 6, device 12 and
  -- network 60 an hour; one number at most 5 codes a day across every org (a stranger cannot be spammed).
  -- No client address (unconfigured proxy) counts as one shared network rather than as no limit.
  v_ip := sha256(convert_to(coalesce(host(private.client_ip()), 'no-client-ip'), 'UTF8'));
  v_phone_hash := sha256(convert_to(v_phone, 'UTF8'));
  delete from private.phone_code_attempts where at < now() - interval '1 day';
  if (select count(*) from private.phone_code_attempts where visit_id = v.id and kind = 'request' and at > now() - interval '1 hour') >= 6
     or (v.device_key_hash is not null and
         (select count(*) from private.phone_code_attempts where device_hash = v.device_key_hash and kind = 'request' and at > now() - interval '1 hour') >= 12)
     or (select count(*) from private.phone_code_attempts where ip_hash = v_ip and kind = 'request' and at > now() - interval '1 hour') >= 60
     or (select count(*) from app.notifications n where n.org_id = v.org_id and n.template_key = 'reply_verify'
                                                      and n.created_at > now() - interval '1 hour') >= 60
     or (select count(*) from private.phone_code_attempts where phone_hash = v_phone_hash and kind = 'request' and at > now() - interval '1 day') >= 5 then
    raise exception 'rate_limited';
  end if;
  insert into private.phone_code_attempts (visit_id, kind, ip_hash, device_hash, phone_hash)
  values (v.id, 'request', v_ip, v.device_key_hash, v_phone_hash);

  -- Facts about the visit and the business, not about the number.
  if private.text_consent_state(v) <> 'on' then
    raise exception 'consent_required';
  end if;
  select * into t from private.resolve_template(v.org_id, v.queue_id, 'reply_verify', 'sms', v.locale);
  if not found or not private.channel_enabled(v.org_id, 'sms') then
    raise exception 'sms_unavailable';
  end if;
  if c.verified_at is not null then
    return row('verified', null)::api.phone_verification;
  end if;

  select * into r from private.phone_codes where visit_id = v.id for update;
  if found and r.last_sent_at > now() - interval '30 seconds' then
    return row('sent', r.last_sent_at + interval '30 seconds')::api.phone_verification;
  end if;
  if found and r.sends >= 3 and r.last_sent_at > now() - interval '1 hour' then
    raise exception 'rate_limited';
  end if;

  -- A number the org already holds, or has opted out, gets the same answers but no message and no matching code.
  v_real := c.id is not null and not exists (select 1 from app.suppressions sp
            where sp.org_id = v.org_id and sp.channel = 'sms' and sp.value = v_phone);
  v_code := lpad((abs((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint)) % 1000000)::text, 6, '0');
  insert into private.phone_codes (visit_id, contact_id, code_hash, expires_at, sends, last_sent_at)
  values (v.id, case when v_real then c.id end,
          case when v_real then private.phone_code_hash(v.id, v_code) else extensions.gen_random_bytes(32) end,
          now() + interval '10 minutes', 1, now())
  on conflict (visit_id) do update
    set contact_id = excluded.contact_id, code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0,
        sends = case when private.phone_codes.last_sent_at > now() - interval '1 hour' then private.phone_codes.sends + 1 else 1 end,
        last_sent_at = now()
  returning * into r;
  if v_real then
    insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                                   category, vars, dedupe_key)
    values (v.org_id, v.id, 'sms', c.id, 'reply_verify', t.version, t.category, jsonb_build_object('code', v_code),
            'reply_verify:' || v.id || ':' || r.sends || ':' || floor(extract(epoch from r.last_sent_at)));
  end if;
  return row('sent', r.last_sent_at + interval '30 seconds')::api.phone_verification;
end $$;
revoke all on function api.guest_request_phone_code(text) from public;
grant execute on function api.guest_request_phone_code(text) to anon, authenticated, service_role;
comment on function api.guest_request_phone_code(text) is
  'Sends a 6-digit code to the phone on the token''s open visit and returns state sent with the earliest resend time, or verified when the '
  'number already is. Needs the visit''s sms consent (consent_required) and texts switched on for the business (sms_unavailable). A number the '
  'business holds or has opted out gets the same answer with no message. Unknown or ended-visit tokens raise not_found; GET raises '
  'invalid_input. rate_limited after 6 requests per visit, 12 per device, 60 per network (or 60 for all callers with no network address) an hour, 60 per business an hour, 5 per number a day, or 3 sends in an hour; '
  'a repeat within 30 seconds returns the same state without sending. The code lives 10 minutes and is stored only as an HMAC.';

create function api.guest_verify_phone_code(p_token text, p_code text) returns api.phone_verification
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  r private.phone_codes;
  v_ip bytea;
  v_ok boolean;
begin
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  v := private.visit_by_token(p_token, true);
  if v.status not in ('expected', 'waiting', 'called', 'serving') then
    raise exception 'not_found';
  end if;

  -- Per visit 20, device 40 and network 120 tries an hour, counted before the code is compared.
  v_ip := sha256(convert_to(coalesce(host(private.client_ip()), 'no-client-ip'), 'UTF8'));
  if (select count(*) from private.phone_code_attempts where visit_id = v.id and kind = 'verify' and at > now() - interval '1 hour') >= 20
     or (v.device_key_hash is not null and
         (select count(*) from private.phone_code_attempts where device_hash = v.device_key_hash and kind = 'verify' and at > now() - interval '1 hour') >= 40)
     or (select count(*) from private.phone_code_attempts where ip_hash = v_ip and kind = 'verify' and at > now() - interval '1 hour') >= 120 then
    raise exception 'rate_limited';
  end if;
  insert into private.phone_code_attempts (visit_id, kind, ip_hash, device_hash) values (v.id, 'verify', v_ip, v.device_key_hash);

  if exists (select 1 from app.guest_contacts gc where gc.org_id = v.org_id and gc.id = v.contact_id and gc.verified_at is not null) then
    return row('verified', null)::api.phone_verification;
  end if;
  -- Wrong, expired, never sent and locked all answer invalid: a failure must not roll back its own count, so it returns.
  select * into r from private.phone_codes where visit_id = v.id for update;
  if not found or r.expires_at <= now() or r.tries >= 5 or p_code is null or p_code !~ '^[0-9]{6}$' then
    if found and p_code is not null then
      update private.phone_codes set tries = tries + 1 where visit_id = v.id;
    end if;
    return row('invalid', null)::api.phone_verification;
  end if;
  update private.phone_codes set tries = tries + 1 where visit_id = v.id;
  v_ok := r.contact_id is not null and r.code_hash = private.phone_code_hash(v.id, p_code);
  if not v_ok then
    return row('invalid', null)::api.phone_verification;
  end if;
  update app.guest_contacts set verified_at = coalesce(verified_at, now())
  where id = r.contact_id and org_id = v.org_id;
  delete from private.phone_codes where visit_id = v.id;
  return row('verified', null)::api.phone_verification;
end $$;
revoke all on function api.guest_verify_phone_code(text, text) from public;
grant execute on function api.guest_verify_phone_code(text, text) to anon, authenticated, service_role;
comment on function api.guest_verify_phone_code(text, text) is
  'Checks a 6-digit code for the token''s open visit and, on a match, marks the phone contact verified (state verified; a repeat after that '
  'also answers verified). Any other outcome (wrong, expired, never requested, five wrong tries) returns state invalid without saying which. '
  'rate_limited after 20 tries per visit, 40 per device, 120 per network an hour. Unknown or ended-visit tokens raise not_found; GET raises '
  'invalid_input.';

notify pgrst, 'reload schema';

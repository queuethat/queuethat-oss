-- Closes the consent oracle in api.guest_grant_consent (Riz, 2026-10-31).
--
-- A guest could type any number at join, call guest_grant_consent, and read the org's contact book
-- from the answer: `contact_suppressed` meant "this org already holds the number or has it
-- opted out", success meant it did not. The function now answers the same way either side of that
-- line, checks the text hash first (so a wrong hash cannot differ by case either), and limits calls
-- per visit, per device and per network. Alternative rejected: a limit alone (still an oracle,
-- just slower).
--
-- Consequence: a number the org already holds (or has opted out) can't be attached to this visit,
-- so it gets no texts, but the guest is told, and sees, "on" until phone verification exists
-- (phase 3). The claim is recorded in private.consent_claims so get_visit_status agrees.

create table private.consent_claims (
  visit_id uuid primary key references app.visits (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- The answer handed out, repeated verbatim on every later call, as a real grant's row would be.
  consent_id uuid not null default gen_random_uuid(),
  contact_id uuid not null default gen_random_uuid()
);
comment on table private.consent_claims is
  'Visits whose guest asked for texts while the number was one the org holds or has opted out. No consent exists; this only keeps api.get_visit_status answering the same as after a real grant.';
revoke all on private.consent_claims from public, anon, authenticated;

alter table private.consent_attempts add column ip_hash bytea;
alter table private.consent_attempts add column device_hash bytea;
create index consent_attempts_ip_idx on private.consent_attempts (ip_hash, at) where ip_hash is not null;
create index consent_attempts_device_idx on private.consent_attempts (device_hash, at) where device_hash is not null;

-- redefines private.text_consent_state from 20261031003600_sms_gate.sql
create or replace function private.text_consent_state(p_visit app.visits) returns text
language sql stable set search_path = '' as $$
  select case
    when p_visit.guest_phone_e164 is null and p_visit.contact_id is null then 'none'
    when coalesce((select c.status = 'granted' and c.revoked_at is null
                   from app.consents c
                   where c.contact_id = p_visit.contact_id and c.channel = 'sms' and c.purpose = 'transactional'
                   order by c.captured_at desc limit 1), false)
      or exists (select 1 from private.consent_claims cc where cc.visit_id = p_visit.id) then 'on'
    when not private.channel_enabled(p_visit.org_id, 'sms') then 'unavailable'
    else 'off'
  end
$$;
comment on function private.text_consent_state(app.visits) is
  'none: the visit has no number; on: the number has a granted sms consent (or the guest asked and the number is one the business already holds, see private.consent_claims); unavailable: a number without consent while the business has texts switched off; off: a number without consent that could opt in.';

-- redefines api.guest_grant_consent from 20261030220117_consent_texts.sql
create or replace function api.guest_grant_consent(p_token text, p_channel text, p_text_version int, p_text_hash text, p_locale text) returns api.consent_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_phone text;
  v_contact uuid;
  v_guest uuid;
  v_text text;
  v_ip bytea;
  c app.consents;
  v_held boolean := false;
begin
  -- The token is a bearer secret: never in a URL (technical-design.md 5).
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  if p_channel is null or p_channel not in ('sms', 'whatsapp') or p_text_version is null or p_text_version < 1
     or p_text_hash is null or p_text_hash !~ '^[0-9a-f]{64}$' or p_locale is null then
    raise exception 'invalid_input';
  end if;
  v := private.visit_by_token(p_token, true);
  if v.status not in ('expected', 'waiting', 'called', 'serving') then
    raise exception 'not_found';
  end if;

  -- Limits first, and the attempt is recorded before anything that depends on the typed number, so
  -- probing is counted whatever the answer. Per visit 10, per device 20, per network 120, each an hour.
  v_ip := case when private.client_ip() is null then null
               else sha256(convert_to(host(private.client_ip()), 'UTF8')) end;
  delete from private.consent_attempts where at < now() - interval '1 day';
  if (select count(*) from private.consent_attempts where visit_id = v.id and at > now() - interval '1 hour') >= 10
     or (v.device_key_hash is not null and
         (select count(*) from private.consent_attempts where device_hash = v.device_key_hash and at > now() - interval '1 hour') >= 20)
     or (v_ip is not null and
         (select count(*) from private.consent_attempts where ip_hash = v_ip and at > now() - interval '1 hour') >= 120) then
    raise exception 'rate_limited';
  end if;
  insert into private.consent_attempts (visit_id, ip_hash, device_hash) values (v.id, v_ip, v.device_key_hash);

  -- The words come before the number: a wrong hash is the same error for every number.
  v_text := private.render_consent_text(v.location_id, p_channel::app.notification_channel, 'transactional', p_locale, p_text_version);
  -- Only the newest published version can be granted, so an old page cannot consent to superseded words.
  if p_text_version < (select max(t.version) from app.consent_texts t
                       where t.channel = p_channel::app.notification_channel and t.purpose = 'transactional' and t.locale = p_locale) then
    raise exception 'consent_text_mismatch';
  end if;
  if v_text is null or encode(sha256(convert_to(v_text, 'UTF8')), 'hex') <> p_text_hash then
    raise exception 'consent_text_mismatch';
  end if;

  select gc.id, gc.guest_id, gc.value into v_contact, v_guest, v_phone
  from app.guest_contacts gc where gc.org_id = v.org_id and gc.id = v.contact_id and gc.channel = 'phone';
  if v_contact is null then
    v_phone := v.guest_phone_e164;
    if v_phone is null then
      raise exception 'invalid_input';
    end if;
    -- A number typed at join is unverified. If the org already knows it, this visit may not attach
    -- to that contact (that would let anyone consent on a stranger's behalf). The answer must not
    -- say so: it is the same as a grant.
    v_held := exists (select 1 from app.guest_contacts gc where gc.org_id = v.org_id and gc.channel = 'phone' and gc.value = v_phone);
  end if;

  if not v_held and exists (select 1 from app.suppressions sp
             where sp.org_id = v.org_id and sp.channel = p_channel::app.notification_channel and sp.value = v_phone) then
    v_held := true;
  end if;

  if not v_held and v_contact is null then
    v_guest := coalesce(v.guest_id, gen_random_uuid());
    insert into app.guests (id, org_id, first_name) values (v_guest, v.org_id, left(v.guest_name, 60))
    on conflict (id) do nothing;
    insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
    values (v.org_id, v_guest, 'phone', v_phone, case when v.source = 'kiosk' then 'kiosk' else 'online' end)
    on conflict (org_id, channel, value) do nothing
    returning id into v_contact;
    if v_contact is null then
      v_held := true; -- another visit just added the same number
    end if;
  end if;

  if v_held then
    insert into private.consent_claims (visit_id) values (v.id) on conflict do nothing;
    -- Same shape and status as a grant, and stable across repeats like one; nothing was written for the number.
    return (select row(cc.consent_id, cc.contact_id, p_channel, 'transactional', 'granted', cc.created_at)::api.consent_row
            from private.consent_claims cc where cc.visit_id = v.id);
  end if;

  if v.contact_id is distinct from v_contact then
    perform private.set_actor('guest', null, 'consent_granted');
    update app.visits set contact_id = v_contact, guest_id = coalesce(guest_id, v_guest) where id = v.id;
  end if;

  select * into c from app.consents x
  where x.contact_id = v_contact and x.channel = p_channel::app.notification_channel and x.purpose = 'transactional'
  order by x.captured_at desc limit 1;
  if c.id is null or c.status <> 'granted' then
    insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version,
                              consent_text_hash, locale)
    values (v.org_id, v_contact, p_channel::app.notification_channel, 'transactional', 'granted',
            case when v.source = 'kiosk' then 'kiosk' else 'online' end, p_text_version::text, p_text_hash, p_locale)
    returning * into c;
  end if;
  return private.consent_row_of(c.id);
end $$;
comment on function api.guest_grant_consent(text, text, int, text, text) is
  'Grants a transactional sms or whatsapp consent for the token''s open visit. The server renders the '
  'published text and refuses a different hash (consent_text_mismatch, checked before anything about the number); the consent stores the version, '
  'hash and locale. Unknown, expired or ended-visit tokens raise the same not_found as get_visit_status; '
  'invalid_input without a phone or over GET. A number the business already holds, or has opted out, '
  'gets the same granted-looking answer as a real grant (no consent is written, the visit gets no texts, '
  'and text_consent reads on), so the call cannot be used to test which numbers the business knows. '
  'rate_limited after 10 calls per visit, 20 per device or 120 per network in an hour; probing is counted '
  'before the number is looked at. A repeat returns the existing consent. Implemented in 3-CG5 (#330).';

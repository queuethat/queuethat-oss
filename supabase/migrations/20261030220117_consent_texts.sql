-- 3-CG5 (#330): versioned opt-in copy and the one guest consent RPC.
--
-- The join page copy is a compliance artifact (10DLC registration needs the exact text), so each
-- published text is an immutable row and every consent stores the version and the sha256 of the
-- exact rendered text the guest saw. api.guest_grant_consent re-renders the text on the server and
-- refuses a hash that differs, so the page can never claim consent to words nobody published.

create table app.consent_texts (
  id uuid primary key default gen_random_uuid(),
  channel app.notification_channel not null check (channel in ('sms', 'whatsapp')),
  purpose app.message_category not null,
  locale text not null,
  version int not null check (version >= 1),
  body text not null,
  published_at timestamptz not null default now(),
  unique (channel, purpose, locale, version)
);
comment on table app.consent_texts is
  'Published opt-in copy, global and append-only. {{business_name}} and {{support_contact}} are filled per location by private.render_consent_text.';
alter table app.consent_texts enable row level security;
create policy consent_texts_select on app.consent_texts for select to authenticated using (true);
revoke insert, update, delete, truncate on app.consent_texts from public, anon, authenticated, service_role;

insert into app.consent_texts (channel, purpose, locale, version, body) values
  ('sms', 'transactional', 'en', 1,
   '{{business_name}} will text you only about this visit: your place in line and when it is your turn. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Questions: {{support_contact}}.'),
  ('whatsapp', 'transactional', 'en', 1,
   '{{business_name}} will message you on WhatsApp only about this visit: your place in line and when it is your turn. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Questions: {{support_contact}}.');

alter table app.consents add column locale text;
create table private.consent_attempts (
  visit_id uuid not null,
  at timestamptz not null default now()
);
create index consent_attempts_visit_idx on private.consent_attempts (visit_id, at);
create index consent_attempts_at_idx on private.consent_attempts (at);

create function private.render_consent_text(
  p_location_id uuid, p_channel app.notification_channel, p_purpose app.message_category, p_locale text, p_version int
) returns text
language sql stable set search_path = '' as $$
  select replace(replace(t.body, '{{business_name}}', o.name), '{{support_contact}}', coalesce(o.support_contact, o.name))
  from app.consent_texts t
  join app.locations l on l.id = p_location_id
  join app.organizations o on o.id = l.org_id
  where t.channel = p_channel and t.purpose = p_purpose and t.locale = p_locale and t.version = p_version
$$;
revoke all on function private.render_consent_text(uuid, app.notification_channel, app.message_category, text, int) from public, anon, authenticated;
comment on function private.render_consent_text(uuid, app.notification_channel, app.message_category, text, int) is
  'The exact opt-in text shown for a location: the published body with the business name and support contact filled in; null when that version is not published. The consent hash is the sha256 hex of this text.';

-- redefines api.guest_grant_consent from 20261030210404_api_contracts_3.sql
create or replace function api.guest_grant_consent(p_token text, p_channel text, p_text_version int, p_text_hash text, p_locale text) returns api.consent_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_phone text;
  v_contact uuid;
  v_guest uuid;
  v_text text;
  c app.consents;
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

  delete from private.consent_attempts where at < now() - interval '1 day';
  if (select count(*) from private.consent_attempts where visit_id = v.id and at > now() - interval '1 hour') >= 10 then
    raise exception 'rate_limited';
  end if;
  insert into private.consent_attempts (visit_id) values (v.id);

  select gc.id, gc.guest_id, gc.value into v_contact, v_guest, v_phone
  from app.guest_contacts gc where gc.org_id = v.org_id and gc.id = v.contact_id and gc.channel = 'phone';
  if v_contact is null then
    v_phone := v.guest_phone_e164;
    if v_phone is null then
      raise exception 'invalid_input';
    end if;
    -- A number typed at join is unverified. If the org already knows it, this visit may not attach
    -- to that contact (that would let anyone consent on a stranger's behalf), so it gets the same
    -- answer as an opted-out number.
    if exists (select 1 from app.guest_contacts gc where gc.org_id = v.org_id and gc.channel = 'phone' and gc.value = v_phone) then
      raise exception 'contact_suppressed';
    end if;
  end if;

  if exists (select 1 from app.suppressions sp
             where sp.org_id = v.org_id and sp.channel = p_channel::app.notification_channel and sp.value = v_phone) then
    raise exception 'contact_suppressed';
  end if;

  v_text := private.render_consent_text(v.location_id, p_channel::app.notification_channel, 'transactional', p_locale, p_text_version);
  -- Only the newest published version can be granted, so an old page cannot consent to superseded words.
  if p_text_version < (select max(t.version) from app.consent_texts t
                       where t.channel = p_channel::app.notification_channel and t.purpose = 'transactional' and t.locale = p_locale) then
    raise exception 'consent_text_mismatch';
  end if;
  if v_text is null or encode(sha256(convert_to(v_text, 'UTF8')), 'hex') <> p_text_hash then
    raise exception 'consent_text_mismatch';
  end if;

  if v_contact is null then
    v_guest := coalesce(v.guest_id, gen_random_uuid());
    insert into app.guests (id, org_id, first_name) values (v_guest, v.org_id, left(v.guest_name, 60))
    on conflict (id) do nothing;
    insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
    values (v.org_id, v_guest, 'phone', v_phone, case when v.source = 'kiosk' then 'kiosk' else 'online' end)
    on conflict (org_id, channel, value) do nothing
    returning id into v_contact;
    if v_contact is null then
      raise exception 'contact_suppressed'; -- another visit just added the same number
    end if;
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
  'published text and refuses a different hash (consent_text_mismatch); the consent stores the version, '
  'hash and locale. Unknown, expired or ended-visit tokens raise the same not_found as get_visit_status; '
  'invalid_input without a phone or over GET; contact_suppressed for an opted-out number or one the org already holds for another guest (a typed number is unverified); rate_limited '
  'after 10 calls per visit per hour. A repeat returns the existing consent. Implemented in 3-CG5 (#330).';

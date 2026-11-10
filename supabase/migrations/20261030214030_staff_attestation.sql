-- 3-CG3 (#328): staff attestation for staff-entered phone numbers.
--
-- A consent with source 'staff' must say who attested and when. api.staff_capture_consent is the
-- only writer: it links the visit's typed phone to a contact (so the dispatcher can look the
-- consent up) and records a transactional consent. Staff never capture marketing consent, and
-- never override an opt-out.
--
-- The CHECK needs attested_at but not captured_by_user_id: that FK is ON DELETE SET NULL, so
-- requiring it would block deleting a staff user. The RPC always sets it.

alter table app.consents
  add column attested_at timestamptz,
  add column attestation_text_version int,
  add constraint consents_staff_attested_check
    check (source <> 'staff' or (attested_at is not null and attestation_text_version is not null));

-- redefines api.staff_capture_consent from 20261030210404_api_contracts_3.sql
create or replace function api.staff_capture_consent(p_visit_id uuid, p_channel text, p_attested boolean, p_text_version int, p_idempotency_key uuid) returns api.consent_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_claim record;
  v_contact uuid;
  v_guest uuid;
  c app.consents;
begin
  if p_channel is null or p_channel not in ('sms', 'whatsapp') or p_text_version is null or p_text_version < 1
     or p_idempotency_key is null or p_attested is null then
    raise exception 'invalid_input';
  end if;
  select * into v from app.visits where id = p_visit_id;
  if v.id is null or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if not p_attested then
    raise exception 'attestation_required';
  end if;
  if v.status not in ('expected', 'waiting', 'called', 'serving') or v.guest_phone_e164 is null and v.contact_id is null then
    raise exception 'invalid_input';
  end if;

  select * into v_claim from private.claim_idempotent(v.org_id, 'staff_capture_consent', p_idempotency_key);
  if v_claim.replay then
    return private.consent_row_of((v_claim.response ->> 'id')::uuid);
  end if;

  select gc.id, gc.guest_id into v_contact, v_guest
  from app.guest_contacts gc
  where gc.org_id = v.org_id and gc.id = v.contact_id and gc.channel = 'phone';
  if v_contact is null then
    select gc.id, gc.guest_id into v_contact, v_guest
    from app.guest_contacts gc
    where gc.org_id = v.org_id and gc.channel = 'phone' and gc.value = v.guest_phone_e164;
  end if;

  if exists (select 1 from app.suppressions sp
             where sp.org_id = v.org_id and sp.channel = p_channel::app.notification_channel
               and sp.value = coalesce(v.guest_phone_e164, (select gc.value from app.guest_contacts gc where gc.id = v_contact))) then
    raise exception 'contact_suppressed';
  end if;

  if v_contact is null then
    v_guest := coalesce(v.guest_id, gen_random_uuid());
    insert into app.guests (id, org_id, first_name)
    values (v_guest, v.org_id, left(v.guest_name, 60))
    on conflict (id) do nothing;
    insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
    values (v.org_id, v_guest, 'phone', v.guest_phone_e164, 'staff')
    returning id into v_contact;
  end if;

  if v.contact_id is distinct from v_contact then
    perform private.set_actor('staff', (select auth.uid()), null, 'consent_captured');
    update app.visits set contact_id = v_contact, guest_id = coalesce(guest_id, v_guest) where id = v.id;
  end if;

  select * into c from app.consents x
  where x.contact_id = v_contact and x.channel = p_channel::app.notification_channel and x.purpose = 'transactional'
  order by x.captured_at desc limit 1;
  if c.id is null or c.status <> 'granted' then
    insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version,
                              consent_text_hash, captured_by_user_id, attested_at, attestation_text_version)
    values (v.org_id, v_contact, p_channel::app.notification_channel, 'transactional', 'granted', 'staff',
            p_text_version::text, encode(sha256(convert_to('staff-attestation:v' || p_text_version, 'UTF8')), 'hex'),
            (select auth.uid()), now(), p_text_version)
    returning * into c;
  end if;
  perform private.save_idempotent('staff_capture_consent', p_idempotency_key, jsonb_build_object('id', c.id));
  return private.consent_row_of(c.id);
end $$;
comment on function api.staff_capture_consent(uuid, text, boolean, int, uuid) is
  'Records a staff-attested transactional consent (sms or whatsapp) for the open visit''s typed phone '
  'and links the visit to that contact. Staff of the visit''s location, otherwise not_found. Raises '
  'attestation_required when p_attested is false and contact_suppressed for an opted-out number '
  '(staff cannot override). An existing granted consent is reused, so repeats are no-ops. '
  'Implemented in 3-CG3 (#328).';

create function private.consent_row_of(p_id uuid) returns api.consent_row
language sql stable set search_path = '' as $$
  select c.id, c.contact_id, c.channel::text, c.purpose::text, c.status, c.captured_at
  from app.consents c where c.id = p_id
$$;
revoke all on function private.consent_row_of(uuid) from public, anon, authenticated;
comment on function private.consent_row_of(uuid) is 'The api.consent_row of a consent. Callers authorize first.';

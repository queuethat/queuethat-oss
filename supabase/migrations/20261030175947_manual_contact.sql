-- N-4 (#254): staff message a guest from their own WhatsApp (wa.me link; no API, no outbox). The
-- phone is handed to the browser only by this call, which audits every tap, so the console never
-- selects contact data. Not a visit state change, so no visit_events row.
create function api.log_manual_contact(p_visit_id uuid, p_channel text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_channel is distinct from 'whatsapp' then
    raise exception 'invalid_input';
  end if;
  if v.guest_phone_e164 is null then
    raise exception 'no_contact';
  end if;
  -- An SMS STOP or a manual block is an opt-out of the number, whatever app staff would use.
  if exists (select 1 from app.suppressions s
             where s.org_id = v.org_id and s.channel in ('sms', 'whatsapp') and s.value = v.guest_phone_e164) then
    raise exception 'suppressed';
  end if;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
  values (v.org_id, auth.uid(), 'staff', 'INSERT', 'manual_contact', v.id::text,
          jsonb_build_object('channel', p_channel, 'visit_id', v.id));
  return v.guest_phone_e164;
end $$;
comment on function api.log_manual_contact(uuid, text) is
  'Records that staff are about to contact the visit''s guest outside the system (channel '
  'whatsapp) in app.audit_log and returns the guest''s E.164 phone for the wa.me link. Staff of '
  'the visit''s location; raises not_found (also across tenants), invalid_input for another '
  'channel, no_contact when the guest left no phone, suppressed for an opted-out number. '
  'Implemented in N4 (#254).';
revoke all on function api.log_manual_contact(uuid, text) from public, anon;
grant execute on function api.log_manual_contact(uuid, text) to authenticated;

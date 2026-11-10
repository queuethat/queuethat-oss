-- #682: anonymizing an appointment (retention and guest erasure) also drops the email and phone typed
-- at booking, its web push subscriptions and the address hash on its notification rows.

-- redefines private.anonymize_appointments from 20261030065000_retention.sql
create or replace function private.anonymize_appointments(p_org_id uuid, p_ids uuid[]) returns int
language plpgsql volatile set search_path = '' as $$
declare
  n int;
begin
  perform private.set_actor('system', null, null, 'retention');
  update app.appointments set guest_name = '—', guest_id = null, contact_id = null,
                              guest_email = null, guest_phone_e164 = null, anonymized_at = now()
  where org_id = p_org_id and id = any (p_ids) and anonymized_at is null;
  get diagnostics n = row_count;
  delete from app.push_subscriptions where org_id = p_org_id and appointment_id = any (p_ids);
  update app.notifications set recipient_hash = null
  where org_id = p_org_id and appointment_id = any (p_ids) and recipient_hash is not null;
  return n;
end $$;

-- 3-CG10 (#335): which live guests can receive texts, for the staff console.
--
-- A new read function rather than a column on api.visit_row (Phase-0 return types are fixed) or
-- three client-side table reads (that would re-derive the consent rules in TypeScript). It is
-- SECURITY DEFINER with an explicit role check, because floor staff may see this status but not the
-- consents and suppressions tables behind it (manager and above only). Callers who are not staff of
-- the location get no rows.

create function api.visit_text_states(p_location_id uuid) returns table (visit_id uuid, text_state text)
language sql stable security definer set search_path = '' as $$
  select v.id,
         case
           when coalesce(v.guest_phone_e164, gc.value) is null then 'none'
           when exists (select 1 from app.suppressions sp
                        where sp.org_id = v.org_id and sp.channel = 'sms'
                          and sp.value = coalesce(v.guest_phone_e164, gc.value)) then 'opted_out'
           when coalesce((select c.status = 'granted' and c.revoked_at is null
                          from app.consents c
                          where c.contact_id = v.contact_id and c.channel = 'sms' and c.purpose = 'transactional'
                          order by c.captured_at desc limit 1), false) then 'on'
           else 'no_consent'
         end
  from app.visits v
  left join app.guest_contacts gc on gc.org_id = v.org_id and gc.id = v.contact_id and gc.channel = 'phone'
  where v.location_id = p_location_id
    and private.has_role(v.org_id, v.location_id, 'staff')
    and v.status in ('expected', 'waiting', 'called', 'serving')
$$;
revoke all on function api.visit_text_states(uuid) from public, anon;
grant execute on function api.visit_text_states(uuid) to authenticated, service_role;
comment on function api.visit_text_states(uuid) is
  'Per live visit of the location: none (no number), on (granted sms consent), no_consent, or opted_out (the number texted STOP; staff cannot override). Staff of the location; other callers see no rows. Implemented in 3-CG10 (#335).';

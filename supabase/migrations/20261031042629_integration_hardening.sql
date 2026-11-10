-- 4-INT1 (#395) security review follow-up.
-- * integration_contact: only a VERIFIED contact is synced (a typed number or address proves nothing), and a
--   suppression on any channel the contact could consent on (sms or whatsapp for a phone) blocks it, since an SMS
--   STOP revokes only sms consents.
-- * enqueue: one job per visit and connection (an undo and re-complete does not write a second note), and a visit
--   the day-end rollover closed was never served, so it is not synced.
-- * consume_integration_state: the user must still be an unrestricted owner/admin of the org when finishing.

-- redefines private.integration_contact from 20261031035524_integration_jobs.sql
create or replace function private.integration_contact(p_org_id uuid, p_visit_id uuid)
returns table (channel text, value text, name text)
language sql stable security definer set search_path = '' as $$
  select gc.channel::text, gc.value, v.guest_name
  from app.visits v
  join app.guest_contacts gc on gc.org_id = v.org_id and gc.id = v.contact_id
  where v.id = p_visit_id and v.org_id = p_org_id and gc.channel in ('phone', 'email') and gc.verified_at is not null
    and exists (select 1 from app.consents c
                where c.org_id = gc.org_id and c.contact_id = gc.id and c.purpose = 'marketing'
                  and c.status = 'granted' and c.revoked_at is null
                  and c.channel::text = any (case gc.channel when 'phone' then array['sms', 'whatsapp'] else array['email'] end))
    and not exists (select 1 from app.suppressions sp
                    where sp.org_id = gc.org_id and sp.value = gc.value
                      and sp.channel::text = any (case gc.channel when 'phone' then array['sms', 'whatsapp'] else array['email'] end))
$$;

-- redefines private.enqueue_integration_jobs from 20261031035524_integration_jobs.sql
create or replace function private.enqueue_integration_jobs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.type = 'complete' and coalesce(new.payload ->> 'auto_closed', 'false') <> 'true'
     and exists (select 1 from private.integration_contact(new.org_id, new.visit_id)) then
    insert into app.integration_jobs (org_id, setting_id, visit_id, event_id)
    select s.org_id, s.id, new.visit_id, 'v:' || new.visit_id
    from app.provider_settings s
    where s.org_id = new.org_id and s.channel in ('pos', 'crm') and s.enabled
    on conflict (setting_id, event_id) do nothing;
    if found then perform private.kick_integrations(); end if;
  end if;
  return null;
end $$;

-- redefines api.consume_integration_state from 20261031035949_integration_oauth.sql
create or replace function api.consume_integration_state(p_state text, p_user_id uuid) returns api.integration_credentials
language plpgsql volatile security definer set search_path = '' as $$
declare
  st app.integration_oauth_states;
  s app.provider_settings;
begin
  delete from app.integration_oauth_states where state_hash = extensions.digest(coalesce(p_state, ''), 'sha256')
  returning * into st;
  -- unknown, expired, used, someone else's, or the user lost their admin role meanwhile: all answer alike
  if not found or st.expires_at < now() or st.user_id is distinct from p_user_id
     or not exists (select 1 from app.memberships m where m.user_id = p_user_id and m.org_id = st.org_id
                    and m.role >= 'admin' and m.location_ids is null) then
    raise exception 'not_found';
  end if;
  select * into s from app.provider_settings where org_id = st.org_id and channel = st.channel;
  if not found then raise exception 'not_found'; end if;
  return (s.org_id, s.channel, s.provider, s.config,
          (select coalesce(jsonb_object_agg(x.key, d.decrypted_secret), '{}')
           from jsonb_each(s.secret_ids) x join vault.decrypted_secrets d on d.id = (x.value #>> '{}')::uuid))::api.integration_credentials;
end $$;

notify pgrst, 'reload schema';

-- PLT5 (#411): an operator ends every session in a compromised tenant, audited.
--
-- Plain definer functions, not the platform-admin Edge Function the ticket sketched: the database
-- already ends sessions (D1's api.revoke_device deletes auth.sessions and bans the device user),
-- and GoTrue's admin sign-out takes the user's own JWT, not a user id. An Edge Function would
-- only forward to the same SQL with the service role (interface rule 3).
--
-- What a sign-out does and does not do: deleting a user's auth.sessions removes their refresh
-- tokens, so each app is signed out at its next token refresh (at most jwt_expiry, 1 hour).
-- The access token in hand stays valid until then. Devices are cut off at once, because
-- private.is_device reads revoked_at. Suspending the org (api.platform_set_org_status) blocks
-- member writes at once but leaves staff-level reads until the tokens expire.

/**
 * Revokes one device for good: sets revoked_at, bans its auth user so no new session can start
 * and deletes its sessions so no refresh token is left. Returns the number of sessions ended.
 * Not SECURITY DEFINER and not granted to any API role: only definer functions call it.
 */
create function private.revoke_device_row(p_device_id uuid) returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_user uuid;
  v_sessions int := 0;
begin
  update app.devices set revoked_at = now()
  where id = p_device_id and revoked_at is null
  returning auth_user_id into v_user;
  if v_user is not null then
    update auth.users set banned_until = now() + interval '100 years' where id = v_user;
    delete from auth.sessions where user_id = v_user;
    get diagnostics v_sessions = row_count;
  end if;
  return v_sessions;
end $$;
revoke all on function private.revoke_device_row(uuid) from public;
comment on function private.revoke_device_row(uuid) is
  'Revokes a device (revoked_at, ban, sessions deleted) unless already revoked; returns the '
  'sessions ended. Called only by definer functions.';

-- redefines api.revoke_device from 20261025001100_devices.sql
create or replace function api.revoke_device(p_device_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  d app.devices;
begin
  select * into d from app.devices where id = p_device_id;
  if not found or not private.has_role(d.org_id, d.location_id, 'admin') then
    raise exception 'not_found';
  end if;
  perform private.revoke_device_row(d.id);
end $$;

create function api.platform_sign_out_members(p_org_id uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_users int;
  v_sessions int;
begin
  perform private.require_platform('operator');
  if length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;

  -- Sessions are global, so a member of several orgs is signed out of all of them. The calling
  -- operator keeps their own session even when they are a member.
  with ended as (
    delete from auth.sessions s
    using app.memberships m
    where m.org_id = p_org_id and s.user_id = m.user_id and m.user_id <> (select auth.uid())
    returning s.user_id
  )
  select count(distinct user_id), count(*) into v_users, v_sessions from ended;

  perform private.platform_audit('org.sign_out_members', p_org_id,
    jsonb_build_object('users', v_users, 'sessions', v_sessions), btrim(p_reason));
  return jsonb_build_object('users', v_users, 'sessions', v_sessions);
end $$;
comment on function api.platform_sign_out_members(uuid, text) is
  'Operator with aal2: signs every member of the org out of every device (their refresh tokens '
  'stop working; open apps sign out at their next token refresh, within an hour) and returns '
  '{users, sessions} ended. Memberships are kept and nobody is banned. The caller''s own sessions '
  'are kept. Every call writes a platform_audit row, even when nothing was signed in. Raises '
  'permission_denied (42501) without operator and aal2, invalid_input for a blank reason or one '
  'over 500 characters, not_found for an unknown org.';

create function api.platform_revoke_devices(p_org_id uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_devices int := 0;
  v_sessions int := 0;
  d record;
begin
  perform private.require_platform('operator');
  if length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;

  for d in select id from app.devices where org_id = p_org_id and revoked_at is null for update loop
    v_sessions := v_sessions + private.revoke_device_row(d.id);
    v_devices := v_devices + 1;
  end loop;

  perform private.platform_audit('org.revoke_devices', p_org_id,
    jsonb_build_object('devices', v_devices, 'sessions', v_sessions), btrim(p_reason));
  return jsonb_build_object('devices', v_devices, 'sessions', v_sessions);
end $$;
comment on function api.platform_revoke_devices(uuid, text) is
  'Operator with aal2: revokes every display and kiosk of the org, as api.revoke_device does for '
  'one (no data access from the next request, no refresh, no new sign-in; they must be paired '
  'again) and returns {devices, sessions} ended. Already revoked devices are skipped. Every call '
  'writes a platform_audit row. Raises permission_denied (42501) without operator and aal2, '
  'invalid_input for a blank reason or one over 500 characters, not_found for an unknown org.';

revoke all on function api.platform_sign_out_members(uuid, text) from public, anon;
revoke all on function api.platform_revoke_devices(uuid, text) from public, anon;
grant execute on function api.platform_sign_out_members(uuid, text) to authenticated;
grant execute on function api.platform_revoke_devices(uuid, text) to authenticated;

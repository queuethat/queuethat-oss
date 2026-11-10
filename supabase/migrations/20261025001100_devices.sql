-- D1 (#48): device pairing. Displays and kiosks are real Supabase Auth users created by the
-- pair-device Edge Function from a 6-digit, 10-minute pairing code (technical-design.md 5).
--
--   admin                      api.create_pairing_code   -> shows the code on screen
--   pair-device (service role) api.redeem_pairing_code   -> claims the code, rate-limited
--                              (creates the auth user through the Auth admin API)
--                              api.register_device       -> app.devices row bound to that user
--   device                     api.device_heartbeat      -> last_seen_at, app_version
--   admin                      api.revoke_device         -> revoked_at, ban, sessions deleted
--
-- Access checks read app.devices (private.is_device), never JWT claims, so a revoked device
-- loses data access on its next request even while its access token is still unexpired.

------------------------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------------------------

create table app.device_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  kind app.device_kind not null,
  name text not null default '',
  -- SHA-256 of the 6-digit code. A 6-digit code is trivially reversible from its hash, so this
  -- only keeps codes out of logs and backups; expiry, single use and rate limits protect it.
  code_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  -- Chosen when the code is redeemed, so the auth user's app_metadata can carry it before the
  -- app.devices row exists. Set means redeemed; the row in app.devices appears on register.
  device_id uuid unique,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade
);
-- Redeeming looks a code up by hash alone, so live codes must be unique across tenants.
create unique index device_pairing_codes_live_idx on app.device_pairing_codes (code_hash)
  where used_at is null;
create index device_pairing_codes_org_idx on app.device_pairing_codes (org_id, expires_at);

create trigger forbid_org_change before update on app.device_pairing_codes
  for each row execute function private.forbid_org_change();

-- Failed redemptions, for rate limiting. Not exposed; only definer functions touch it.
create table private.pairing_failures (
  client_hash bytea not null,
  at timestamptz not null default now()
);
create index pairing_failures_client_idx on private.pairing_failures (client_hash, at);
create index pairing_failures_at_idx on private.pairing_failures (at);

alter table app.device_pairing_codes enable row level security;

-- Admins see their codes (D2 lists pending ones); every write goes through the RPCs below.
create policy device_pairing_codes_select on app.device_pairing_codes for select to authenticated
  using ((select private.has_role(org_id, location_id, 'admin')));

-- Heartbeats update last_seen_at every few seconds; auditing them would bury real changes.
drop trigger audit_row on app.devices;
create trigger audit_row after insert or delete on app.devices
  for each row execute function private.audit_row();
create trigger audit_row_update after update on app.devices
  for each row
  when ((to_jsonb(old) - 'last_seen_at' - 'app_version')
        is distinct from (to_jsonb(new) - 'last_seen_at' - 'app_version'))
  execute function private.audit_row();

------------------------------------------------------------------------------------------------
-- Types
------------------------------------------------------------------------------------------------

create type api.pairing_code as (code text, expires_at timestamptz);

create type api.device_claim as (
  device_id uuid,
  org_id uuid,
  location_id uuid,
  kind app.device_kind,
  name text,
  scopes text[]
);

grant usage on type api.pairing_code to authenticated;
grant usage on type api.device_claim to service_role;

------------------------------------------------------------------------------------------------
-- Admin
------------------------------------------------------------------------------------------------

create function api.create_pairing_code(p_location_id uuid, p_kind app.device_kind, p_name text)
returns api.pairing_code
language plpgsql volatile security definer set search_path = '' as $$
declare
  loc app.locations;
  result api.pairing_code;
  h bytea;
begin
  select * into loc from app.locations where id = p_location_id;
  if not found or not private.has_role(loc.org_id, loc.id, 'admin') then
    raise exception 'not_found';
  end if;
  if p_kind is null or length(coalesce(p_name, '')) > 80 then
    raise exception 'invalid_input';
  end if;
  -- Live codes share one 6-digit space across tenants; a cap per org keeps a guess unlikely.
  if (select count(*) from app.device_pairing_codes
      where org_id = loc.org_id and used_at is null and expires_at > now()) >= 10 then
    raise exception 'rate_limited';
  end if;

  result.expires_at := now() + interval '10 minutes';
  loop
    result.code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint
                          % 1000000)::text), 6, '0');
    h := extensions.digest(result.code, 'sha256');
    -- An expired, unused code with the same digits must not block the new one.
    delete from app.device_pairing_codes
    where code_hash = h and used_at is null and expires_at <= now();
    begin
      insert into app.device_pairing_codes (org_id, location_id, kind, name, code_hash, expires_at,
                                            created_by)
      values (loc.org_id, loc.id, p_kind, btrim(coalesce(p_name, '')), h, result.expires_at,
              (select auth.uid()));
      exit;
    exception when unique_violation then
      null; -- another live code has these digits; draw again
    end;
  end loop;

  return result;
end $$;
comment on function api.create_pairing_code(uuid, app.device_kind, text) is
  'Creates a single-use 6-digit code that pairs one display or kiosk to the location, valid for '
  '10 minutes, and returns it with its expiry. The code itself is never stored, so it cannot be '
  'shown again; create a new one instead. Admins of the location only. Raises not_found for a '
  'location the caller does not administer, invalid_input for a missing kind or a name over 80 '
  'characters, rate_limited when the org already has 10 live codes.';

create function api.revoke_device(p_device_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  d app.devices;
begin
  select * into d from app.devices where id = p_device_id;
  if not found or not private.has_role(d.org_id, d.location_id, 'admin') then
    raise exception 'not_found';
  end if;
  if d.revoked_at is not null then
    return;
  end if;

  update app.devices set revoked_at = now() where id = d.id;
  if d.auth_user_id is not null then
    -- Ban so the refresh token grant fails, and end every session so no refresh token is left.
    update auth.users set banned_until = now() + interval '100 years' where id = d.auth_user_id;
    delete from auth.sessions where user_id = d.auth_user_id;
  end if;
end $$;
comment on function api.revoke_device(uuid) is
  'Unpairs a device for good: it loses data access on its next request, its refresh token stops '
  'working and it cannot sign in again. Pair the screen again with a new code. Revoking twice '
  'changes nothing. Admins of the device''s location only; raises not_found otherwise.';

------------------------------------------------------------------------------------------------
-- Device
------------------------------------------------------------------------------------------------

create function api.device_heartbeat(p_app_version text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update app.devices
  set last_seen_at = now(), app_version = left(p_app_version, 64)
  where auth_user_id = (select auth.uid()) and revoked_at is null;
  if not found then
    raise exception 'not_found';
  end if;
end $$;
comment on function api.device_heartbeat(text) is
  'Records that the calling device is alive and which app version it runs. Raises not_found when '
  'the caller is not an active paired device, which is how a revoked screen learns to go back to '
  'the pairing screen.';

------------------------------------------------------------------------------------------------
-- pair-device Edge Function (service role only)
------------------------------------------------------------------------------------------------

create function api.redeem_pairing_code(p_code text, p_client_key text) returns api.device_claim
language plpgsql volatile security definer set search_path = '' as $$
declare
  client bytea := extensions.digest(coalesce(p_client_key, ''), 'sha256');
  c app.device_pairing_codes;
  result api.device_claim;
begin
  delete from private.pairing_failures where at < now() - interval '10 minutes';
  if (select count(*) from private.pairing_failures where client_hash = client) >= 5
     or (select count(*) from private.pairing_failures) >= 100 then
    raise exception 'rate_limited';
  end if;

  select * into c from app.device_pairing_codes
  where code_hash = extensions.digest(coalesce(p_code, ''), 'sha256')
    and used_at is null and expires_at > now()
  for update;
  if not found then
    insert into private.pairing_failures (client_hash) values (client);
    return null;
  end if;

  update app.device_pairing_codes
  set used_at = now(), device_id = gen_random_uuid()
  where id = c.id
  returning device_id into result.device_id;

  result.org_id := c.org_id;
  result.location_id := c.location_id;
  result.kind := c.kind;
  result.name := c.name;
  result.scopes := '{}';
  return result;
end $$;
comment on function api.redeem_pairing_code(text, text) is
  'Claims a pairing code for the pair-device Edge Function and returns what the new device''s '
  'auth user carries in app_metadata. Returns null for an unknown, expired or already used code, '
  'without saying which. p_client_key identifies the caller (its IP); only its hash is kept. '
  'Raises rate_limited after 5 failures from one client, or 100 from everyone, in 10 minutes.';

create function api.register_device(p_device_id uuid, p_auth_user_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  c app.device_pairing_codes;
begin
  select * into c from app.device_pairing_codes where device_id = p_device_id;
  if not found or p_auth_user_id is null then
    raise exception 'not_found';
  end if;
  insert into app.devices (id, org_id, location_id, kind, name, auth_user_id)
  values (c.device_id, c.org_id, c.location_id, c.kind, c.name, p_auth_user_id)
  on conflict (id) do nothing;
  if not exists (select 1 from app.devices where id = p_device_id and auth_user_id = p_auth_user_id) then
    raise exception 'not_found';
  end if;
end $$;
comment on function api.register_device(uuid, uuid) is
  'Creates the app.devices row for a redeemed code, bound to the auth user the pair-device Edge '
  'Function created for it; from then on the device passes private.is_device. Repeating the call '
  'with the same user changes nothing. Raises not_found for a device id no code was redeemed '
  'for, or one already bound to a different user.';

------------------------------------------------------------------------------------------------
-- Grants
------------------------------------------------------------------------------------------------

revoke all on function
  api.create_pairing_code(uuid, app.device_kind, text),
  api.revoke_device(uuid),
  api.device_heartbeat(text),
  api.redeem_pairing_code(text, text),
  api.register_device(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  api.create_pairing_code(uuid, app.device_kind, text),
  api.revoke_device(uuid),
  api.device_heartbeat(text)
to authenticated;

grant execute on function
  api.redeem_pairing_code(text, text),
  api.register_device(uuid, uuid)
to service_role;

-- O6 (#77): how often each paired screen loses live updates, sent with its heartbeat, so a
-- kiosk or display with a bad connection shows up on the Devices page. App versions per screen
-- were already recorded (D1). Guest and staff browsers are not tracked (#398).

alter table app.devices
  add column realtime_drops int not null default 0,
  add column last_drop_at timestamptz;

-- Heartbeat columns, drops included, are not audited (see 20261025001100_devices.sql).
drop trigger audit_row_update on app.devices;
create trigger audit_row_update after update on app.devices
  for each row
  when ((to_jsonb(old) - 'last_seen_at' - 'app_version' - 'realtime_drops' - 'last_drop_at')
        is distinct from (to_jsonb(new) - 'last_seen_at' - 'app_version' - 'realtime_drops' - 'last_drop_at'))
  execute function private.audit_row();

-- redefines api.device_heartbeat from 20261025001100_devices.sql, appending a defaulted param.
drop function api.device_heartbeat(text);
create function api.device_heartbeat(p_app_version text, p_disconnects int default 0) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  -- Device input: a count per minute's heartbeat, clamped so one call can't inflate it.
  drops int := least(greatest(coalesce(p_disconnects, 0), 0), 100);
begin
  update app.devices
  set last_seen_at = now(), app_version = left(p_app_version, 64),
      realtime_drops = realtime_drops + drops,
      last_drop_at = case when drops > 0 then now() else last_drop_at end
  where auth_user_id = (select auth.uid()) and revoked_at is null;
  if not found then
    raise exception 'not_found';
  end if;
end $$;
comment on function api.device_heartbeat(text, int) is
  'Records that the calling device is alive, which app version it runs and how many times live '
  'updates dropped since its last heartbeat (p_disconnects, clamped to 0..100; adds to '
  'realtime_drops and sets last_drop_at). Raises not_found when the caller is not an active '
  'paired device, which is how a revoked screen learns to go back to the pairing screen.';

revoke all on function api.device_heartbeat(text, int) from public, anon, authenticated, service_role;
grant execute on function api.device_heartbeat(text, int) to authenticated;

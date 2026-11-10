import type { Database } from '@qm/db-types';
import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { isConnecting } from './status.ts';

export type DeviceKind = Database['app']['Enums']['device_kind'];

/** How often the list refreshes, so a screen that stops checking in turns offline on its own. */
export const DEVICES_REFRESH_MS = 30_000;
/** How often it refreshes while a new screen is waiting for its first heartbeat. */
const CONNECTING_REFRESH_MS = 3_000;

/** The location's paired screens that are not revoked, newest first. RLS shows them to admins. */
export const devicesQuery = (locationId: string) =>
  queryOptions({
    queryKey: ['admin', 'devices', locationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('devices')
        .select(
          'id, kind, name, counter_id, last_seen_at, app_version, realtime_drops, last_drop_at, created_at',
        )
        .eq('location_id', locationId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false });
      if (error) throw new Error(errorCode(error));
      return data;
    },
    refetchInterval: (query) =>
      query.state.data?.some((d) => isConnecting(d, Date.now()))
        ? CONNECTING_REFRESH_MS
        : DEVICES_REFRESH_MS,
  });

/**
 * Creates a single-use code that pairs one screen to the location (`api.create_pairing_code`).
 * The code cannot be shown again once this result is gone. Errors: `not_found` (not an admin),
 * `invalid_input`, `rate_limited` (10 live codes).
 */
export function useCreatePairingCode(locationId: string) {
  return useMutation({
    mutationFn: async ({ kind, name }: { kind: DeviceKind; name: string }) => {
      const { data, error } = await supabase.rpc('create_pairing_code', {
        p_location_id: locationId,
        p_kind: kind,
        p_name: name.trim(),
      });
      if (error) throw new Error(errorCode(error));
      return data as { code: string; expires_at: string };
    },
  });
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether a code from `useCreatePairingCode` has paired a screen yet: the code is used and the
 * screen's row exists (pair-device redeems first, then registers). Only the code's hash is
 * stored, so this looks it up by hash; RLS shows both to the location's admins. Polls until true.
 */
export const pairingCodeUsedQuery = (code: string) =>
  queryOptions({
    queryKey: ['admin', 'pairing-code', code],
    queryFn: async () => {
      const codes = supabase.schema('app').from('device_pairing_codes');
      const { data, error } = await codes
        .select('device_id')
        .eq('code_hash', `\\x${await sha256Hex(code)}`)
        .maybeSingle();
      if (error) throw new Error(errorCode(error));
      if (!data?.device_id) return false;
      const devices = await supabase
        .schema('app')
        .from('devices')
        .select('id')
        .eq('id', data.device_id);
      if (devices.error) throw new Error(errorCode(devices.error));
      return devices.data.length > 0;
    },
    refetchInterval: (query) => (query.state.data ? false : 2_000),
  });

/** Unpairs a screen for good (`api.revoke_device`); it shows the pairing screen again. */
export function useRevokeDevice(locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      const { error } = await supabase.rpc('revoke_device', { p_device_id: deviceId });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'devices', locationId] }),
  });
}

/**
 * Binds a display to one counter, or to none when `counterId` is null (`api.set_device_counter`).
 * A bound display is a counter screen at `/display/counter`. Errors: `not_found`, `invalid_input`.
 */
export function useSetDeviceCounter(locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ deviceId, counterId }: { deviceId: string; counterId: string | null }) => {
      const { error } = await supabase.rpc('set_device_counter', {
        p_device_id: deviceId,
        p_counter_id: counterId as string,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'devices', locationId] }),
  });
}

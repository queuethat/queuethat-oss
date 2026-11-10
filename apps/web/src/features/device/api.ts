import { errorCode, type ErrorCode } from '@qm/domain';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError, type Session } from '@supabase/supabase-js';
import { liveDrops } from '../../lib/live.ts';
import { supabase } from '../../lib/supabase.ts';
import { sessionQuery } from '../auth/api.ts';
import { APP_VERSION, POLL_MS } from './version.ts';

/** Thrown by `usePairDevice`; `code` is what the pair-device function answered. */
export class PairError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

/**
 * Redeems a pairing code (pair-device Edge Function, D1 #48) and stores the device's session,
 * replacing whoever was signed in on this browser.
 */
export function usePairDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const { data, error } = await supabase.functions.invoke<{ session: Session }>('pair-device', {
        body: { code },
      });
      if (error instanceof FunctionsHttpError) {
        const body = await (error.context as Response).json().catch(() => null);
        throw new PairError(errorCode({ message: body?.error }));
      }
      if (error || !data) throw new PairError('unknown');
      const { error: sessionError } = await supabase.auth.setSession(data.session);
      if (sessionError) throw new PairError('unknown');
    },
    onSuccess: () => queryClient.invalidateQueries(sessionQuery),
  });
}

/** Ends the device session on this browser only (the server already revoked it). */
export function useForgetDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => supabase.auth.signOut({ scope: 'local' }),
    onSettled: () => queryClient.invalidateQueries(sessionQuery),
  });
}

/**
 * api.device_heartbeat every POLL_MS, carrying the version and the live-update drops since the
 * last one. Its error is `not_found` once the device is revoked.
 */
export function useDeviceHeartbeat() {
  return useQuery({
    queryKey: ['device', 'heartbeat'],
    queryFn: async () => {
      const drops = liveDrops.count();
      const { error } = await supabase.rpc('device_heartbeat', {
        p_app_version: APP_VERSION,
        p_disconnects: drops,
      });
      if (error) throw error;
      liveDrops.ack(drops);
      return Date.now();
    },
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });
}

export const servedVersionQuery = queryOptions({
  queryKey: ['device', 'served-version'],
  queryFn: async () => {
    const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`version.json ${response.status}`);
    return ((await response.json()) as { version: string }).version;
  },
  refetchInterval: POLL_MS,
  refetchIntervalInBackground: true,
});

/** The version currently deployed, polled every POLL_MS. */
export function useServedVersion() {
  return useQuery(servedVersionQuery);
}

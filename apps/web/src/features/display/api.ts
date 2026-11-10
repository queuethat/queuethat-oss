import { queryOptions, useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.ts';
import { useLiveQuery } from '../../lib/live.ts';

// T1 (#66): the waiting-room TV's one read, api.display_snapshot (V10). One query-options
// factory and one hook per RPC (apps/web/README.md).

async function fetchDisplaySnapshot(locationId: string) {
  const { data, error } = await supabase.rpc('display_snapshot', { p_location_id: locationId });
  if (error) throw error;
  return data;
}

export const displaySnapshotQuery = (locationId: string) =>
  queryOptions({
    queryKey: ['display', 'snapshot', locationId],
    queryFn: () => fetchDisplaySnapshot(locationId),
  });

/**
 * What the TV shows for its location: per queue, now serving and next up, with names only when
 * the location opted in (the database decides). Refetched on every signal on the location's
 * private topic, which paired devices may follow, and every 30 s. One TV per room, so no jitter.
 */
export function useDisplaySnapshot(locationId: string | undefined) {
  const { queryKey } = displaySnapshotQuery(locationId ?? '');
  return useLiveQuery({
    queryKey,
    queryFn: () => fetchDisplaySnapshot(locationId ?? ''),
    topic: locationId ? `loc:${locationId}` : null,
    enabled: !!locationId,
    jitterMs: 0,
  });
}

async function fetchLocationTimeZone(locationId: string) {
  const { data, error } = await supabase
    .schema('app')
    .from('locations')
    .select('tz')
    .eq('id', locationId)
    .single();
  if (error) throw error;
  return data.tz;
}

/**
 * The location's IANA time zone, so the board shows times in the location's zone rather than the
 * device's (I-6). Paired devices may read their location (RLS). A zone change is rare, so it is
 * read again every 10 minutes rather than on every signal.
 */
export function useLocationTimeZone(locationId: string | undefined) {
  return useQuery({
    queryKey: ['display', 'tz', locationId],
    queryFn: () => fetchLocationTimeZone(locationId ?? ''),
    enabled: !!locationId,
    staleTime: 10 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}

export interface OnsiteCode {
  code: string;
  /** When the next code takes over (ms since epoch). */
  validUntilMs: number;
  /** The rotation window, for the countdown ring. */
  windowMs: number;
}

async function fetchOnsiteCode(locationId: string): Promise<OnsiteCode | null> {
  const { data, error } = await supabase.rpc('display_onsite_code', { p_location_id: locationId });
  if (error) throw error;
  if (!data.required || !data.code || !data.valid_until) return null;
  const { data: location, error: windowError } = await supabase
    .schema('app')
    .from('locations')
    .select('onsite_code_rotate_minutes')
    .eq('id', locationId)
    .single();
  if (windowError) throw windowError;
  return {
    code: data.code,
    validUntilMs: Date.parse(data.valid_until),
    windowMs: location.onsite_code_rotate_minutes * 60_000,
  };
}

/** Longest the board goes without asking again, in case an admin turns the code on or off. */
const ONSITE_POLL_MS = 30_000;

/**
 * The current on-site join code for the TV (2A-JN5), or null when the location doesn't require
 * one. Asks again just after `valid_until`, so the new code shows within a few seconds of the
 * rotation, and at least every 30 s.
 */
export function useOnsiteCode(locationId: string | undefined) {
  return useQuery({
    queryKey: ['display', 'onsite-code', locationId],
    queryFn: () => fetchOnsiteCode(locationId ?? ''),
    enabled: !!locationId,
    refetchInterval: (query) => {
      const until = query.state.data?.validUntilMs;
      if (!until) return ONSITE_POLL_MS;
      return Math.min(ONSITE_POLL_MS, Math.max(1_000, until - Date.now() + 500));
    },
  });
}

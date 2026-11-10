import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { useLiveQuery } from '../../../lib/live.ts';

// O2 (#73): today's counts for the admin home. One query-options factory and one hook per RPC
// (apps/web/README.md).

async function fetchTodayStats(locationId: string) {
  const { data, error } = await supabase.rpc('today_stats', { p_location_id: locationId });
  if (error) throw error;
  return data;
}

export const todayStatsQuery = (locationId: string) =>
  queryOptions({
    queryKey: ['admin', 'today-stats', locationId],
    queryFn: () => fetchTodayStats(locationId),
  });

/**
 * The location's counts for its current service day, refetched on every signal on the
 * location's private topic (any queue, any visit) and every 30 s. Staff refetch immediately.
 */
export function useTodayStats(locationId: string | undefined) {
  const { queryKey } = todayStatsQuery(locationId ?? '');
  return useLiveQuery({
    queryKey,
    queryFn: () => fetchTodayStats(locationId ?? ''),
    topic: locationId ? `loc:${locationId}` : null,
    enabled: !!locationId,
    jitterMs: 0,
  });
}

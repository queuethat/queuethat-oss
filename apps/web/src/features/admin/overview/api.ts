import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface LocationTile {
  locationId: string;
  name: string;
  queuesOpen: number;
  waiting: number;
  longestWaitMin: number | null;
  etaLow: number | null;
  etaHigh: number | null;
  asOf: string;
}

/** How often the overview refreshes: one `api.org_overview` call covers every location. */
export const OVERVIEW_POLL_MS = 30_000;

/** Live numbers for every location the caller can see, from `api.org_overview`. */
export const overviewQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['admin', 'overview', orgId],
    refetchInterval: OVERVIEW_POLL_MS,
    queryFn: async (): Promise<LocationTile[]> => {
      const { data, error } = await supabase.rpc('org_overview', { p_org_id: orgId });
      if (error) throw error;
      return data.map((r) => ({
        locationId: r.location_id ?? '',
        name: r.location_name ?? '',
        queuesOpen: r.queues_open ?? 0,
        waiting: r.waiting_count ?? 0,
        longestWaitMin: r.longest_wait_min,
        etaLow: r.eta_low,
        etaHigh: r.eta_high,
        asOf: r.as_of ?? '',
      }));
    },
  });

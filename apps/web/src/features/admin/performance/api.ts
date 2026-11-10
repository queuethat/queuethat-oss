import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export type PerformanceGroup = 'staff' | 'counter';

export interface PerformanceFilter {
  locationId: string;
  /** Local dates, YYYY-MM-DD, both included. */
  from: string;
  to: string;
  by: PerformanceGroup;
}

/** One staff member or counter; times in whole minutes. */
export interface PerformanceRow {
  id: string;
  label: string;
  served: number;
  avgServiceMin: number | null;
  avgCallToStartMin: number | null;
  noShows: number;
}

const minutes = (s: number | null) => (s === null ? null : Math.round((s / 60) * 10) / 10);

/**
 * Per-staff or per-counter figures from `api.staff_performance`. The database decides which rows
 * the caller may see (managers all, staff their own); this only converts seconds to minutes.
 */
export const performanceQuery = (f: PerformanceFilter) =>
  queryOptions({
    queryKey: ['admin', 'performance', f],
    queryFn: async (): Promise<PerformanceRow[]> => {
      const { data, error } = await supabase.rpc('staff_performance', {
        p_location_id: f.locationId,
        p_from_day: f.from,
        p_to_day: f.to,
        p_by: f.by,
      });
      if (error) throw error;
      return data.map((r) => ({
        id: r.grp_id ?? '',
        label: r.label ?? '',
        served: r.served ?? 0,
        avgServiceMin: minutes(r.avg_service_sec),
        avgCallToStartMin: minutes(r.avg_wait_sec),
        noShows: r.no_shows ?? 0,
      }));
    },
  });

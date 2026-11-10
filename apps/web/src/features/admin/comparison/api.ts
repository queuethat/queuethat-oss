import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface ComparisonRow {
  id: string;
  name: string;
  visits: number;
  avgWaitMin: number | null;
  avgServiceMin: number | null;
  noShowPct: number | null;
  withinEtaPct: number | null;
  medianServiceMin: number | null;
  abandonmentPct: number | null;
  avgRating: number | null;
}

/** One row per location from `api.location_comparison`; the database owns every definition. */
export const comparisonQuery = (orgId: string, from: string, to: string) =>
  queryOptions({
    queryKey: ['admin', 'comparison', orgId, from, to],
    queryFn: async (): Promise<ComparisonRow[]> => {
      const { data, error } = await supabase.rpc('location_comparison', {
        p_org_id: orgId,
        p_from_day: from,
        p_to_day: to,
      });
      if (error) throw error;
      return data.map((r) => ({
        id: r.location_id ?? '',
        name: r.location_name ?? '',
        visits: r.visits ?? 0,
        avgWaitMin: r.avg_wait_min,
        avgServiceMin: r.avg_service_min,
        noShowPct: r.no_show_pct,
        withinEtaPct: r.within_eta_pct,
        medianServiceMin: r.median_service_min,
        abandonmentPct: r.abandonment_pct,
        avgRating: r.avg_rating,
      }));
    },
  });

import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export type EtaGroup = 'day' | 'service';

export interface EtaAccuracyFilter {
  locationId: string;
  /** Local dates, YYYY-MM-DD, both included. */
  from: string;
  to: string;
  group: EtaGroup;
}

/** One day or service: percentages and minutes exactly as `api.eta_accuracy` returns them. */
export interface EtaAccuracyRow {
  group: string;
  visits: number;
  withinPct: number | null;
  earlyPct: number | null;
  latePct: number | null;
  avgLateMin: number | null;
  medianErrorMin: number | null;
  p90ErrorMin: number | null;
  biasMin: number | null;
  excludedNoQuote: number;
}

/**
 * How often the quoted ETA range held, from `api.eta_accuracy`. The database classifies each
 * visit as early, within or late; this only renames the columns.
 */
export const etaAccuracyQuery = (f: EtaAccuracyFilter) =>
  queryOptions({
    queryKey: ['admin', 'eta-accuracy', f],
    queryFn: async (): Promise<EtaAccuracyRow[]> => {
      const { data, error } = await supabase.rpc('eta_accuracy', {
        p_location_id: f.locationId,
        p_from_day: f.from,
        p_to_day: f.to,
        p_group: f.group,
      });
      if (error) throw error;
      return data.map((r) => ({
        group: r.grp ?? '',
        visits: r.visits ?? 0,
        withinPct: r.within_range_pct,
        earlyPct: r.pct_early,
        latePct: r.pct_late,
        avgLateMin: r.avg_late_min,
        medianErrorMin: r.median_error_min,
        p90ErrorMin: r.p90_error_min,
        biasMin: r.bias_min,
        excludedNoQuote: r.excluded_no_quote ?? 0,
      }));
    },
  });

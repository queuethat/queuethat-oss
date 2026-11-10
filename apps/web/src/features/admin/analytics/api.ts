import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export type Bucket = 'day' | 'hour';

export interface AnalyticsFilter {
  locationId: string;
  /** Local dates, YYYY-MM-DD, both included. */
  from: string;
  to: string;
  bucket: Bucket;
  queueId: string;
  serviceId: string;
}

/** One row of the analytics table: history figures joined to outcome rates by bucket. */
export interface AnalyticsRow {
  key: string;
  label: string;
  joined: number;
  served: number;
  p50WaitMin: number | null;
  p90WaitMin: number | null;
  abandonment: number | null;
  noShow: number | null;
}

const minutes = (s: number | null) => (s === null ? null : Math.round(s / 60));

/**
 * History and outcome figures for a range, read through `api.history_stats` and
 * `api.outcome_rates`. The database owns every definition (docs/ops/analytics-definitions.md);
 * this only lines the two result sets up by bucket.
 */
export const analyticsQuery = (f: AnalyticsFilter) =>
  queryOptions({
    queryKey: ['admin', 'analytics', f],
    queryFn: async (): Promise<AnalyticsRow[]> => {
      const range = {
        p_location_id: f.locationId,
        p_from: f.from,
        p_to: f.to,
        p_bucket: f.bucket,
      };
      const [history, outcomes] = await Promise.all([
        supabase.rpc('history_stats', {
          ...range,
          ...(f.queueId ? { p_queue_id: f.queueId } : {}),
          ...(f.serviceId ? { p_service_id: f.serviceId } : {}),
        }),
        supabase.rpc('outcome_rates', range),
      ]);
      if (history.error) throw history.error;
      if (outcomes.error) throw outcomes.error;
      const rates = new Map(outcomes.data.map((o) => [o.bucket_start, o]));
      return history.data.map((h) => {
        const o = rates.get(h.bucket_start);
        return {
          key: h.bucket_start ?? '',
          label: h.bucket_label ?? '',
          joined: h.joined ?? 0,
          served: h.served ?? 0,
          p50WaitMin: minutes(h.p50_wait_s),
          p90WaitMin: minutes(h.p90_wait_s),
          abandonment: o?.abandonment_rate ?? null,
          noShow: o?.no_show_rate ?? null,
        };
      });
    },
  });

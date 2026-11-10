import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../../../lib/supabase.ts';

/** How many days ahead of the purge owners are warned (matches the reminder email). */
export const PURGE_WARNING_DAYS = 30;

export interface ExpiringWaivers {
  count: number;
  /** Acceptance time of the oldest record, which is the first to go. */
  oldest: string | null;
  /** Records accepted before this instant are deleted within the warning window. */
  cutoff: string;
}

/**
 * Waiver records the purge deletes within the next 30 days: accepted more than
 * (retention - 30) days ago. Read under RLS, so queue-scoped staff would see only their lines
 * (the panel itself is shown to managers).
 */
export const expiringWaiversQuery = (orgId: string, retentionDays: number) =>
  queryOptions({
    queryKey: ['admin', 'waiver-expiring', orgId, retentionDays],
    queryFn: async (): Promise<ExpiringWaivers> => {
      const cutoff = new Date(
        Date.now() - Math.max(0, retentionDays - PURGE_WARNING_DAYS) * 86_400_000,
      ).toISOString();
      const { count, error } = await supabase
        .schema('app')
        .from('waiver_acceptances')
        .select('id', { count: 'exact', head: true })
        .lt('accepted_at', cutoff);
      if (error) throw error;
      if (!count) return { count: 0, oldest: null, cutoff };
      const first = await supabase
        .schema('app')
        .from('waiver_acceptances')
        .select('accepted_at')
        .lt('accepted_at', cutoff)
        .order('accepted_at')
        .limit(1)
        .single();
      if (first.error) throw first.error;
      return { count, oldest: first.data.accepted_at, cutoff };
    },
  });

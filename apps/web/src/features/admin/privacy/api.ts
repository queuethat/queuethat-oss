import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export const RETENTION_MIN = 1;
export const RETENTION_MAX = 365;
/** Encrypted backups keep data this long after it is anonymized in the live database. */
export const BACKUP_DAYS = 14;

export interface RetentionRun {
  id: number;
  ranAt: string;
  visitsAnonymized: number;
  contactsDeleted: number;
  appointmentsAnonymized: number;
}

const privacyKey = (orgId: string) => ['admin', 'privacy', orgId] as const;

/** How long the business keeps guest contact details, in days. Any member may read it. */
export const retentionQuery = (orgId: string) =>
  queryOptions({
    queryKey: [...privacyKey(orgId), 'retention'],
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .select('retention_days')
        .eq('id', orgId)
        .single();
      if (error) throw new Error(errorCode(error));
      return data.retention_days;
    },
  });

/** The last 10 daily clean-ups. RLS shows them to admins and owners only. */
export const retentionRunsQuery = (orgId: string) =>
  queryOptions({
    queryKey: [...privacyKey(orgId), 'runs'],
    queryFn: async (): Promise<RetentionRun[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('retention_runs')
        .select('id, ran_at, visits_anonymized, contacts_deleted, appointments_anonymized')
        .eq('org_id', orgId)
        .order('ran_at', { ascending: false })
        .limit(10);
      if (error) throw new Error(errorCode(error));
      return data.map((r) => ({
        id: r.id,
        ranAt: r.ran_at,
        visitsAnonymized: r.visits_anonymized,
        contactsDeleted: r.contacts_deleted,
        appointmentsAnonymized: r.appointments_anonymized,
      }));
    },
  });

/**
 * Sets the retention period. Admins and owners only (RLS); the database audits the change and
 * refuses anything outside 1 to the platform cap (365 hosted; retention_over_cap).
 */
export function useSetRetention(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (days: number) => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .update({ retention_days: days })
        .eq('id', orgId)
        .select('id');
      if (error) throw new Error(errorCode(error));
      // RLS hides rows the caller may not change instead of failing.
      if (data.length === 0) throw new Error('permission_denied');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: privacyKey(orgId) }),
  });
}

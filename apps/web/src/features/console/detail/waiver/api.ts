import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

/** One accepted agreement on a visit: what was agreed, when, and who typed the name. */
export interface WaiverRecord {
  id: string;
  acceptedAt: string;
  agreement: string;
  formName: string;
  version: number;
  typedName: string | null;
  guardianName: string | null;
}

/**
 * The waiver evidence of a visit (W4), including the one taken when the guest booked the appointment
 * the visit came from. Read under RLS, so queue-scoped staff only get their own lines' records.
 */
export const visitWaiversQuery = (visitId: string) =>
  queryOptions({
    queryKey: ['console', 'waivers', visitId],
    queryFn: async (): Promise<WaiverRecord[]> => {
      const appointments = await supabase
        .schema('app')
        .from('appointments')
        .select('id')
        .eq('visit_id', visitId);
      if (appointments.error) throw appointments.error;
      const subjects = [visitId, ...appointments.data.map((a) => a.id)];
      const { data, error } = await supabase
        .schema('app')
        .from('waiver_acceptances')
        .select(
          'id, accepted_at, field_key, typed_name, guardian_name, form_versions(version, fields, forms(name))',
        )
        .in('subject_id', subjects)
        .order('accepted_at');
      if (error) throw error;
      return data.map((r) => {
        const fields = (r.form_versions?.fields ?? []) as { key?: string; label?: string }[];
        return {
          id: r.id,
          acceptedAt: r.accepted_at,
          agreement: fields.find((f) => f.key === r.field_key)?.label ?? r.field_key,
          formName: r.form_versions?.forms?.name ?? '',
          version: r.form_versions?.version ?? 0,
          typedName: r.typed_name,
          guardianName: r.guardian_name,
        };
      });
    },
  });

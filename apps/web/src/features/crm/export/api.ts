import { errorCode } from '@qm/domain';
import { useMutation } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import { toCsv } from '../csv.ts';

/**
 * `api.export_guests` as CSV text (owner or admin; five per day). Errors: `rate_limited`,
 * `not_found`, `mfa_required`.
 */
export function useExportGuests() {
  const org = useCurrentOrg();
  return useMutation({
    mutationFn: async (): Promise<string> => {
      if (!org) throw new Error('not_found');
      const { data, error } = await supabase.rpc('export_guests', { p_org_id: org.id });
      if (error) throw new Error(errorCode(error));
      return toCsv([
        ['name', 'phone', 'email', 'tags', 'notes', 'visits', 'last_visit', 'consent'],
        ...data.map((g) => [
          g.name,
          g.phone_e164,
          g.email,
          (g.tags ?? []).join(';'),
          g.notes,
          g.visit_count,
          g.last_visit_at,
          JSON.stringify(g.consent ?? {}),
        ]),
      ]);
    },
  });
}

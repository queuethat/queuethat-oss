import { errorCode } from '@qm/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import type { ImportRow } from './mapping.ts';

export interface ImportResult {
  rowNo: number;
  outcome: string;
  error: string | null;
}

/**
 * `api.import_guests` for one batch (at most 1000 rows). Errors: `invalid_input`, `not_found`,
 * `mfa_required`. `rowNo` counts within the batch, from 1.
 */
export function useImportGuests() {
  const org = useCurrentOrg();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (rows: ImportRow[]): Promise<ImportResult[]> => {
      if (!org) throw new Error('not_found');
      const { data, error } = await supabase.rpc('import_guests', {
        p_org_id: org.id,
        p_rows: rows as never,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
      return data.map((r) => ({ rowNo: r.row_no ?? 0, outcome: r.outcome ?? '', error: r.error }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'guests'] }),
  });
}

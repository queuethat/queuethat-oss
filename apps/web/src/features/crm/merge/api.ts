import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface DuplicatePair {
  keepId: string;
  mergeId: string;
  reason: string;
  score: number;
}

const duplicatesKey = ['crm', 'duplicates'] as const;

/** `api.duplicate_guest_candidates`: likely duplicate pairs, best first (manager or above). */
export const duplicatesQuery = (orgId: string) =>
  queryOptions({
    queryKey: [...duplicatesKey, orgId],
    queryFn: async (): Promise<DuplicatePair[]> => {
      const { data, error } = await supabase.rpc('duplicate_guest_candidates', {
        p_org_id: orgId,
      });
      if (error) throw new Error(errorCode(error));
      return data.map((p) => ({
        keepId: p.keep_id!,
        mergeId: p.merge_id!,
        reason: p.reason ?? '',
        score: Number(p.score ?? 0),
      }));
    },
  });

/**
 * `api.merge_guests`: moves everything of `mergeId` onto `keepId` (admin or above). Errors:
 * `not_found`, `invalid_input`. Refreshes the pair list and every guest view.
 */
export function useMergeGuests() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { keepId: string; mergeId: string }) => {
      const { error } = await supabase.rpc('merge_guests', {
        p_keep_id: input.keepId,
        p_merge_id: input.mergeId,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: duplicatesKey }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'guests'] }),
        queryClient.invalidateQueries({ queryKey: ['crm'] }),
      ]),
  });
}

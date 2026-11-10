import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export const SINGLE_ACTIVE_SCOPES = ['off', 'location', 'org'] as const;
export type SingleActiveScope = (typeof SINGLE_ACTIVE_SCOPES)[number];

const key = (orgId: string) => ['admin', 'org', orgId, 'single-active-visit'];

/** Whether one phone or contact may hold only one active visit (J-16), and across what. */
export const singleActiveQuery = (orgId: string) =>
  queryOptions({
    queryKey: key(orgId),
    queryFn: async (): Promise<SingleActiveScope> => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .select('single_active_visit')
        .eq('id', orgId)
        .single();
      if (error) throw error;
      return data.single_active_visit as SingleActiveScope;
    },
  });

/** Admins and owners only (RLS hides the row from anyone else, so no row changes). */
export function useSetSingleActive(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (scope: SingleActiveScope) => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .update({ single_active_visit: scope })
        .eq('id', orgId)
        .select('id');
      if (error) throw new Error(errorCode(error));
      if (data.length === 0) throw new Error('permission_denied');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(orgId) }),
  });
}

import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** Whether the org requires owners and admins to be on an aal2 (authenticator) session. */
export const requireMfaQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['org-require-mfa', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .select('require_mfa_for_admins')
        .eq('id', orgId)
        .single();
      if (error) throw error;
      return data.require_mfa_for_admins;
    },
  });

/**
 * Owner only, from an aal2 session: `api.set_require_mfa`. Rejects with Error(<error code>),
 * e.g. `mfa_required` or `permission_denied`.
 */
export function useSetRequireMfa(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (required: boolean) => {
      const { error } = await supabase.rpc('set_require_mfa', {
        p_org_id: orgId,
        p_required: required,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['org-require-mfa', orgId] }),
  });
}

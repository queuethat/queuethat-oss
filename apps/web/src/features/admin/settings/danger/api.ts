import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

/**
 * `api.get_org_deletion`: when the purge is due, or null when none is pending. Reads through the
 * owner's membership because a pending org fails every role check (RLS shows nothing else).
 */
export const orgDeletionQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['admin', 'org-deletion', orgId],
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase.rpc('get_org_deletion', { p_org_id: orgId });
      if (error) throw new Error(errorCode(error));
      return data;
    },
    refetchInterval: 60_000,
  });

/** Everything the signed-in views cache about the org changes when it is locked or restored. */
function useRefreshOrg() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries();
}

/** `api.request_org_deletion`. Errors: `invalid_input` (wrong slug), `not_found`, `permission_denied`, `mfa_required`. */
export function useRequestOrgDeletion(orgId: string) {
  const refresh = useRefreshOrg();
  return useMutation({
    mutationFn: async (slug: string) => {
      const { error } = await supabase.rpc('request_org_deletion', {
        p_org_id: orgId,
        p_confirm_slug: slug,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: refresh,
  });
}

/** `api.cancel_org_deletion`: access returns at once. */
export function useCancelOrgDeletion(orgId: string) {
  const refresh = useRefreshOrg();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('cancel_org_deletion', { p_org_id: orgId });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: refresh,
  });
}

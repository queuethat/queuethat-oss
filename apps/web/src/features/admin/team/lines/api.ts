import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

const key = (orgId: string) => ['admin', 'team', orgId, 'lines'] as const;

/** Whether this org limits staff to the lines assigned to them (`scope_staff_to_lines`). */
export const scopeStaffQuery = (orgId: string) =>
  queryOptions({
    queryKey: [...key(orgId), 'setting'],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .select('scope_staff_to_lines')
        .eq('id', orgId)
        .single();
      if (error) throw error;
      return data.scope_staff_to_lines;
    },
  });

/** Admins and owners only: RLS hides the row from anyone else, so no row changes. */
export function useSetScopeStaff(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (on: boolean) => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .update({ scope_staff_to_lines: on })
        .eq('id', orgId)
        .select('id');
      if (error) throw new Error(errorCode(error));
      if (data.length === 0) throw new Error('permission_denied');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(orgId) }),
  });
}

/** Each staff member's assigned lines (`queue_ids`, null = every line). Admins and owners read it. */
export const memberLinesQuery = (orgId: string) =>
  queryOptions({
    queryKey: [...key(orgId), 'members'],
    queryFn: async (): Promise<Record<string, string[] | null>> => {
      const { data, error } = await supabase
        .schema('app')
        .from('memberships')
        .select('id, queue_ids')
        .eq('org_id', orgId);
      if (error) throw error;
      return Object.fromEntries(data.map((m) => [m.id, m.queue_ids]));
    },
  });

/**
 * `api.set_member_lines`: one staff member's lines (null = all). Owners and admins (a location-scoped
 * admin only within their locations). Errors: `forbidden_role`, `invalid_input`, `permission_denied`.
 */
export function useSetMemberLines(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { membershipId: string; queueIds: string[] | null }) => {
      const { error } = await supabase.rpc('set_member_lines', {
        p_membership_id: input.membershipId,
        // PostgREST sends a JSON null for "every line".
        p_queue_ids: input.queueIds as string[],
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(orgId) }),
  });
}

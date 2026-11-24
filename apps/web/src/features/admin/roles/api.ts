import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface CustomRole {
  id: string;
  name: string;
  permissions: string[];
}

/** The query key every roles query hangs under, for invalidation. */
export const rolesKey = (orgId: string) => ['admin', 'roles', orgId] as const;

/** The org's custom roles, readable by every member. */
export const customRolesQuery = (orgId: string) =>
  queryOptions({
    queryKey: [...rolesKey(orgId), 'list'],
    queryFn: async (): Promise<CustomRole[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('custom_roles')
        .select('id, name, permissions')
        .eq('org_id', orgId)
        .order('name');
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

/** Which role each member holds (membership id to role id). RLS shows all rows to admins and owners. */
export const memberRolesQuery = (orgId: string) =>
  queryOptions({
    queryKey: [...rolesKey(orgId), 'members'],
    queryFn: async (): Promise<Record<string, string | null>> => {
      const { data, error } = await supabase
        .schema('app')
        .from('memberships')
        .select('id, custom_role_id')
        .eq('org_id', orgId);
      if (error) throw new Error(errorCode(error));
      return Object.fromEntries(data.map((m) => [m.id, m.custom_role_id]));
    },
  });

/** `api.set_member_custom_role`: null removes the role. Owners only; the member must be staff. */
export function useAssignRole(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { membershipId: string; roleId: string | null }) => {
      const { error } = await supabase.rpc('set_member_custom_role', {
        p_membership_id: input.membershipId,
        // The generated type says string; the function reads null as "no custom role".
        p_custom_role_id: input.roleId as string,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: rolesKey(orgId) }),
  });
}

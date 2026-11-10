import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/**
 * The permissions an owner can hand to a custom role, grouped for the editor. The database owns
 * the catalogue and rejects anything else (`invalid_input`); this list only decides what to draw.
 */
export const PERMISSION_GROUPS = [
  { group: 'queue', permissions: ['visits.call', 'visits.remove'] },
  { group: 'payments', permissions: ['payments.charge', 'payments.refund'] },
] as const;

export type GrantablePermission = (typeof PERMISSION_GROUPS)[number]['permissions'][number];

export interface CustomRole {
  id: string;
  name: string;
  permissions: string[];
}

const rolesKey = (orgId: string) => ['admin', 'roles', orgId] as const;

/** Whether the role may create, edit and delete custom roles (RLS: owners only). */
export const canEditRoles = (role: string | undefined) => role === 'owner';

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

/** Creates a role, or renames and re-permissions one. Errors: `invalid_input` (name taken, bad permission). */
export function useSaveRole(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id?: string; name: string; permissions: string[] }) => {
      const row = { name: input.name.trim(), permissions: input.permissions };
      const table = supabase.schema('app').from('custom_roles');
      const { error } = input.id
        ? await table.update(row).eq('id', input.id)
        : await table.insert({ org_id: orgId, ...row });
      if (error) {
        // The unique index on the name and the validation trigger both mean "not acceptable".
        throw new Error(error.code === '23505' ? 'invalid_input' : errorCode(error));
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: rolesKey(orgId) }),
  });
}

/** Deletes a role nobody holds. A role in use fails with `role_in_use` (the database refuses it). */
export function useDeleteRole(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.schema('app').from('custom_roles').delete().eq('id', id);
      if (error) throw new Error(error.code === '23503' ? 'role_in_use' : errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: rolesKey(orgId) }),
  });
}

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

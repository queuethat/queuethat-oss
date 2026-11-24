// SPDX-License-Identifier: LicenseRef-QueueThat-EE
// Copyright (c) QueueThat. Licensed under the QueueThat Commercial License (ee/LICENSE).

import { errorCode } from '@qm/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rolesKey } from '@app/features/admin/roles/api.ts';
import { supabase } from '@app/lib/supabase.ts';

/**
 * The permissions an owner can hand to a custom role, grouped for the editor. The database owns
 * the catalogue and rejects anything else (`invalid_input`); this list only decides what to draw.
 */
export const PERMISSION_GROUPS = [
  { group: 'queue', permissions: ['visits.call', 'visits.remove'] },
  { group: 'payments', permissions: ['payments.charge', 'payments.refund'] },
] as const;

export type GrantablePermission = (typeof PERMISSION_GROUPS)[number]['permissions'][number];

/** Whether the role may create, edit and delete custom roles (RLS: owners only). */
export const canEditRoles = (role: string | undefined) => role === 'owner';

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

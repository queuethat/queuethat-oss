import { errorCode } from '@qm/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import type { OrgStatus } from '../api.ts';

// PLT12 (#418): the operator's tenant actions. One hook per RPC. The database decides who may
// call them (operator at aal2) and writes the audit row; each hook returns that row so the page
// can show what was recorded.

const KNOWN_ERRORS = ['permission_denied', 'invalid_input', 'not_found', 'not_a_member'] as const;

/** A failed action's code as the page words it; anything else is `unknown`. */
export function actionError(error: Error): (typeof KNOWN_ERRORS)[number] | 'unknown' {
  return KNOWN_ERRORS.find((code) => code === error.message) ?? 'unknown';
}

/** The `platform_audit` row an action wrote. */
export interface AuditEntry {
  action: string;
  reason: string | null;
  at: string;
}

/** The id of the newest `platform_audit` row about the org, or 0 when there is none. */
async function newestAuditId(orgId: string): Promise<number> {
  const { data, error } = await supabase
    .schema('app')
    .from('platform_audit')
    .select('id')
    .eq('org_id', orgId)
    .order('id', { ascending: false })
    .limit(1);
  if (error) throw new Error(errorCode(error));
  return data[0]?.id ?? 0;
}

/**
 * The `platform_audit` row written after `after`, or null when the call wrote none: repeating a
 * status or transferring to the sole owner changes nothing and records nothing.
 */
async function auditSince(orgId: string, after: number): Promise<AuditEntry | null> {
  const { data, error } = await supabase
    .schema('app')
    .from('platform_audit')
    .select('action, reason, at')
    .eq('org_id', orgId)
    .gt('id', after)
    .order('id', { ascending: false })
    .limit(1);
  if (error) throw new Error(errorCode(error));
  return data[0] ?? null;
}

/** What one action reports: the audit row it wrote (none for a no-op), and the RPC's counts. */
export interface ActionResult {
  audit: AuditEntry | null;
  counts: Record<string, number>;
}

function useAction<Input>(
  orgId: string,
  call: (input: Input) => PromiseLike<{ error: unknown; data?: unknown }>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Input): Promise<ActionResult> => {
      const before = await newestAuditId(orgId);
      const { error, data } = await call(input);
      if (error) throw new Error(errorCode(error));
      const counts =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, number>)
          : {};
      return { audit: await auditSince(orgId, before), counts };
    },
    // The detail page, the directory badge and the audit list all read what the action changed.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['platform'] }),
  });
}

/** Suspends or restores the org (`api.platform_set_org_status`). */
export const useSetOrgStatus = (orgId: string) =>
  useAction(
    orgId,
    (input: { status: Extract<OrgStatus, 'active' | 'suspended'>; reason: string }) =>
      supabase.rpc('platform_set_org_status', {
        p_org_id: orgId,
        p_status: input.status,
        p_reason: input.reason,
      }),
  );

/** Makes an existing member the only owner (`api.platform_transfer_ownership`). */
export const useTransferOwnership = (orgId: string) =>
  useAction(orgId, (input: { email: string; reason: string }) =>
    supabase.rpc('platform_transfer_ownership', {
      p_org_id: orgId,
      p_new_owner_email: input.email,
      p_reason: input.reason,
    }),
  );

/** Opens one hour of read-only access; the owners are emailed (`api.platform_break_glass`). */
export const useBreakGlass = (orgId: string) =>
  useAction(orgId, (input: { reason: string }) =>
    supabase.rpc('platform_break_glass', { p_org_id: orgId, p_reason: input.reason }),
  );

/** Ends every member's sessions (`api.platform_sign_out_members`). */
export const useSignOutMembers = (orgId: string) =>
  useAction(orgId, (input: { reason: string }) =>
    supabase.rpc('platform_sign_out_members', { p_org_id: orgId, p_reason: input.reason }),
  );

/** Revokes every display and kiosk (`api.platform_revoke_devices`). */
export const useRevokeDevices = (orgId: string) =>
  useAction(orgId, (input: { reason: string }) =>
    supabase.rpc('platform_revoke_devices', { p_org_id: orgId, p_reason: input.reason }),
  );

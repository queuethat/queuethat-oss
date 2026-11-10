import type { Database } from '@qm/db-types';
import { ERROR_CODES, errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { PlanLimitError } from '../billing/planLimit.tsx';

export type MemberRole = Database['app']['Enums']['member_role'];

/** Roles in ladder order, most powerful last. The database owns who may grant which. */
export const MEMBER_ROLES: MemberRole[] = ['staff', 'manager', 'admin', 'owner'];

export interface Member {
  id: string;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  role: MemberRole;
  locationIds: string[] | null;
  hasPin: boolean;
}

export interface PendingInvitation {
  id: string;
  email: string;
  displayName: string | null;
  role: MemberRole;
  locationIds: string[] | null;
  expiresAt: string;
}

const teamKey = (orgId: string) => ['admin', 'team', orgId] as const;

/** Whether the role may invite and manage people (the database enforces the same ladder). */
export const canManageTeam = (role: string | undefined) => role === 'admin' || role === 'owner';

/** Whether `actor` may grant or change `target` (owners any role, admins manager and below). */
export const canManageRole = (actor: string | undefined, target: string) =>
  actor === 'owner' || (actor === 'admin' && (target === 'staff' || target === 'manager'));

/** The three roles the team screen leads with, each mapped to an existing role value. */
export const ROLE_PRESETS = [
  { preset: 'owner', role: 'owner' },
  { preset: 'manager', role: 'manager' },
  { preset: 'frontdesk', role: 'staff' },
] as const satisfies readonly { preset: string; role: MemberRole }[];

/** The presets `actor` may hand out (the same `canManageRole` ladder the database enforces). */
export const grantablePresets = (actor: string | undefined) =>
  ROLE_PRESETS.filter((p) => canManageRole(actor, p.role));

/** `api.list_members`: any member may call it; emails come back only for admins and owners. */
export const membersQuery = (orgId: string) =>
  queryOptions({
    queryKey: [...teamKey(orgId), 'members'],
    queryFn: async (): Promise<Member[]> => {
      const { data, error } = await supabase.rpc('list_members', { p_org_id: orgId });
      if (error) throw new Error(errorCode(error));
      return data
        .filter((m) => !m.removed_at)
        .map((m) => ({
          id: m.id!,
          userId: m.user_id,
          email: m.email,
          displayName: m.display_name,
          role: m.role as MemberRole,
          locationIds: m.location_ids,
          hasPin: !!m.has_pin,
        }));
    },
  });

/** Unaccepted, unrevoked, unexpired invitations. RLS shows them to admins and owners only. */
export const invitationsQuery = (orgId: string) =>
  queryOptions({
    queryKey: [...teamKey(orgId), 'invitations'],
    queryFn: async (): Promise<PendingInvitation[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('invitations')
        .select('id, email, display_name, role, location_ids, expires_at')
        .eq('org_id', orgId)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });
      if (error) throw new Error(errorCode(error));
      return data.map((i) => ({
        id: i.id,
        email: i.email,
        displayName: i.display_name,
        role: i.role,
        locationIds: i.location_ids,
        expiresAt: i.expires_at,
      }));
    },
  });

export interface InviteInput {
  email: string;
  role: MemberRole;
  /** Null = every location. */
  locationIds: string[] | null;
  displayName: string;
}

/** Maps the invite-staff function's `{ error }` answer (or a network failure) to the error to throw. */
async function inviteError(error: unknown): Promise<Error> {
  const response = (error as { context?: unknown } | null)?.context;
  if (response instanceof Response) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      limit?: unknown;
    } | null;
    if (body?.error === 'plan_limit_reached') {
      return new PlanLimitError(typeof body.limit === 'number' ? body.limit : undefined);
    }
    if (body?.error === 'send_failed') return new Error('send_failed');
    if (body?.error && (ERROR_CODES as readonly string[]).includes(body.error)) {
      return new Error(body.error);
    }
  }
  return new Error('unknown');
}

async function invite(orgId: string, input: InviteInput) {
  const { error } = await supabase.functions.invoke('invite-staff', {
    body: {
      org_id: orgId,
      email: input.email.trim(),
      role: input.role,
      location_ids: input.locationIds,
      display_name: input.displayName.trim() || null,
      idempotency_key: crypto.randomUUID(),
    },
  });
  if (error) throw await inviteError(error);
}

/**
 * Emails an invitation through the `invite-staff` function (it needs the Auth admin API and
 * SMTP). Errors: `invalid_input`, `forbidden_role`, `permission_denied`, `rate_limited`,
 * `send_failed` (the invitation was withdrawn again).
 */
export function useInviteStaff(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteInput) => invite(orgId, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: teamKey(orgId) }),
  });
}

/** `api.revoke_invitation`: the link stops working. Revoking twice is a no-op. */
export function useRevokeInvitation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('revoke_invitation', {
        p_invitation_id: id,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: teamKey(orgId) }),
  });
}

/** Sends a fresh link: the old invitation is revoked, then a new one is mailed. */
export function useResendInvitation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (previous: PendingInvitation) => {
      const revoked = await supabase.rpc('revoke_invitation', {
        p_invitation_id: previous.id,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (revoked.error) throw new Error(errorCode(revoked.error));
      await invite(orgId, {
        email: previous.email,
        role: previous.role,
        locationIds: previous.locationIds,
        displayName: previous.displayName ?? '',
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: teamKey(orgId) }),
  });
}

/** `api.set_member_role`. Errors: `forbidden_role`, `last_owner`, `permission_denied`, `not_found`. */
export function useSetMemberRole(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; role: MemberRole; locationIds: string[] | null }) => {
      const { error } = await supabase.rpc('set_member_role', {
        p_membership_id: input.id,
        p_role: input.role,
        // The generated type says string[]; the function reads null as "every location".
        p_location_ids: input.locationIds as string[],
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: teamKey(orgId) }),
  });
}

/** `api.remove_member`: access ends at once and their sessions are signed out. */
export function useRemoveMember(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; reason: string }) => {
      const { error } = await supabase.rpc('remove_member', {
        p_membership_id: input.id,
        p_reason: input.reason.trim(),
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: teamKey(orgId) }),
  });
}

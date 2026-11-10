import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { lastErrorId } from '../../../lib/lastError.ts';
import { supabase } from '../../../lib/supabase.ts';
import { APP_VERSION } from '../../device/version.ts';

export type SupportScope = 'read' | 'act';

/**
 * The org's support grants, newest first: owner grants and operator break-glass, live or ended.
 * Every member reads them under RLS (`support_grants_select`), so the whole team can see when
 * support has access. Refetched every minute, so a revoke or an expiry clears the banner.
 */
export const supportGrantsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['support-grants', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('support_grants')
        .select('id, scope, reason, break_glass, created_at, expires_at, revoked_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
    refetchInterval: 60_000,
  });

export type SupportGrant = Awaited<
  ReturnType<NonNullable<ReturnType<typeof supportGrantsQuery>['queryFn']>>
>[number];

/** Grants support can use right now: not revoked and not expired. */
export function liveGrants(grants: readonly SupportGrant[], now: number): SupportGrant[] {
  return grants.filter((g) => g.revoked_at === null && Date.parse(g.expires_at) > now);
}

/**
 * Owner only: opens support access through `api.grant_support_access`, replacing any earlier
 * owner grant, or ends every live grant (break-glass too) through `api.revoke_support_access`.
 * Rejects with Error(<error code>), e.g. `permission_denied` or `invalid_input`.
 */
export function useChangeSupportAccess(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      change:
        { kind: 'grant'; scope: SupportScope; hours: number; reason: string } | { kind: 'revoke' },
    ) => {
      const { error } =
        change.kind === 'grant'
          ? await supabase.rpc('grant_support_access', {
              p_org_id: orgId,
              p_scope: change.scope,
              p_hours: change.hours,
              p_reason: change.reason.trim(),
            })
          : await supabase.rpc('revoke_support_access', { p_org_id: orgId });
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['support-grants', orgId] }),
  });
}

/** What the browser tells support about itself. The database keeps only a whitelist of it. */
export type SupportContext = {
  /** The page path only; the database drops any query string or fragment as well. */
  route?: string;
  app_version: string;
  browser: string;
  viewport: { w: number; h: number };
  online: boolean;
  last_error_id?: string;
};

/**
 * The context to attach to a support request. No storage, cookies, query string, fragment or
 * guest data: a path, the build, the browser, the window and whether it is online.
 */
export function collectSupportContext(includePage: boolean): SupportContext {
  const errorId = lastErrorId();
  return {
    ...(includePage ? { route: window.location.pathname } : {}),
    app_version: APP_VERSION,
    browser: navigator.userAgent.slice(0, 200),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    online: navigator.onLine,
    ...(errorId ? { last_error_id: errorId } : {}),
  };
}

export interface SupportMessage {
  orgId: string;
  subject: string;
  message: string;
  includePage: boolean;
}

/**
 * Sends a support request through `api.contact_support` and resolves with its reference (SR-000123).
 * Rejects with Error(<error code>): `rate_limited`, `invalid_input`, `not_found`, `not_authenticated`
 * or `offline` when the browser has no connection (nothing is sent, so nothing is lost silently).
 */
export function useContactSupport() {
  return useMutation({
    mutationFn: async (m: SupportMessage): Promise<string> => {
      if (!navigator.onLine) throw new Error('offline');
      const { data, error } = await supabase.rpc('contact_support', {
        p_org_id: m.orgId,
        p_subject: m.subject,
        p_message: m.message,
        p_context: collectSupportContext(m.includePage),
      });
      if (error)
        throw new Error(
          errorCode(error) === 'permission_denied' ? 'not_authenticated' : errorCode(error),
        );
      return data;
    },
  });
}

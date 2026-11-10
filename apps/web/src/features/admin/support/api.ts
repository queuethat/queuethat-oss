import { errorCode } from '@qm/domain';
import { useMutation } from '@tanstack/react-query';
import { lastErrorId } from '../../../lib/lastError.ts';
import { supabase } from '../../../lib/supabase.ts';
import { APP_VERSION } from '../../device/version.ts';

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

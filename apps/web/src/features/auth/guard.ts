import type { QueryClient } from '@tanstack/react-query';
import { redirect, type ParsedLocation } from '@tanstack/react-router';
import { membershipsQuery, sessionQuery } from './api.ts';
import { needsMfaChallenge } from './mfa/api.ts';

interface GuardContext {
  context: { queryClient: QueryClient };
  location: ParsedLocation;
}

/**
 * Route guard for screens that need a signed-in person. Signed out → `/auth/sign-in`, which
 * returns here afterwards. A paired TV or kiosk is signed in too, but as a device, so it goes
 * back to its own screen. Returns the session. Route files load this module with a dynamic
 * import so the Supabase client stays out of the guest bundle.
 */
export async function requireSession({ context, location }: GuardContext) {
  const session = await context.queryClient.ensureQueryData(sessionQuery);
  if (!session) throw redirect({ to: '/auth/sign-in', search: { next: location.href } });
  const kind: unknown = session.user.app_metadata?.kind;
  if (kind === 'display' || kind === 'kiosk') throw redirect({ to: `/${kind}` });
  return session;
}

// Memberships use fetchQuery, not ensureQueryData: right after onboarding invalidates them, a
// stale cached "no memberships" must not bounce the new owner back to /onboarding.

/**
 * Guard for `/staff` and `/admin`: a signed-in member of at least one organization. Users with
 * no membership go to `/onboarding` to create one.
 */
export async function requireMember(args: GuardContext) {
  const session = await requireSession(args);
  const memberships = await args.context.queryClient.fetchQuery(membershipsQuery(session.user.id));
  if (memberships.length === 0) throw redirect({ to: '/onboarding' });
  // An enrolled account passes its second factor before reaching the floor or the admin.
  if (await needsMfaChallenge())
    throw redirect({ to: '/auth/mfa', search: { next: args.location.href } });
}

/** Guard for `/onboarding`: signed in and not yet a member of anything. */
export async function requireNonMember(args: GuardContext) {
  const session = await requireSession(args);
  const memberships = await args.context.queryClient.fetchQuery(membershipsQuery(session.user.id));
  if (memberships.length > 0) throw redirect({ to: '/staff' });
}

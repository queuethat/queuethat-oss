import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQuery } from '@tanstack/react-query';
import { setLiveAuth } from '../../lib/live.ts';
import { queryClient } from '../../lib/query.ts';
import { supabase } from '../../lib/supabase.ts';
import { RESET_PATH } from './next.ts';

// Staff accounts (A1, #41): Supabase Auth with email + password or an emailed link.
// Screens use these hooks and `authErrorCode`; they never call `supabase.auth` themselves.

export const sessionQuery = queryOptions({
  queryKey: ['auth', 'session'],
  queryFn: async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session;
  },
  staleTime: Infinity,
});

// The auth client is the source of truth; mirror every change (sign-in, sign-out, refresh,
// a link opened in another tab) into the query cache so screens re-render.
supabase.auth.onAuthStateChange((_event, session) => {
  queryClient.setQueryData(sessionQuery.queryKey, session);
  setLiveAuth(session?.access_token ?? null);
});

/** The current Supabase Auth session, or null when signed out. */
export function useSession() {
  return useQuery(sessionQuery);
}

/** The signed-in user's memberships, each with its organization (RLS: you see your own). */
export const membershipsQuery = (userId: string) =>
  queryOptions({
    queryKey: ['auth', 'memberships', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('memberships')
        .select('org_id, role, organizations(id, name)')
        .eq('user_id', userId);
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
  });

/** Every location the user may work at, across their organizations (RLS decides which). */
export const locationsQuery = (userId: string) =>
  queryOptions({
    queryKey: ['auth', 'locations', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('locations')
        .select('id, org_id, name, slug, tz, country_code, created_at')
        .order('name');
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
  });

/** Where emailed links land. `next` must already be a safe path (see `safeNext`). */
function callbackUrl(next: string) {
  const url = new URL('/auth/callback', window.location.origin);
  url.searchParams.set('next', next);
  return url.toString();
}

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'weak_password'
  | 'same_password'
  | 'wrong_password'
  | 'rate_limited'
  | 'captcha_failed'
  | 'link_invalid'
  | 'link_other_browser'
  | 'code_invalid'
  | 'totp_invalid'
  | 'totp_locked'
  | 'unknown';

/** Maps a Supabase Auth error (or the `error_code` of a failed link) to what the screen shows. */
export function authErrorCode(error: unknown): AuthErrorCode {
  const code =
    typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
  switch (code) {
    case 'invalid_credentials':
    case 'email_not_confirmed':
    case 'weak_password':
    case 'same_password':
    case 'wrong_password':
    case 'code_invalid':
      return code;
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return 'rate_limited';
    // Auth's CAPTCHA (#76) refused the request: no token, or one Cloudflare rejected.
    case 'captcha_failed':
      return 'captcha_failed';
    // A wrong or stale authenticator code (PLT11). Repeated failures arrive as a rate limit.
    case 'mfa_verification_failed':
    case 'mfa_challenge_expired':
      return 'totp_invalid';
    // The per-account lockout (private.mfa_verification_attempt) after five wrong codes.
    case 'mfa_verification_rejected':
      return 'totp_locked';
    case 'otp_expired':
    case 'flow_state_expired':
    case 'flow_state_not_found':
      return 'link_invalid';
    default:
      return 'unknown';
  }
}

/** Supabase's answers that would reveal an address already has an account. */
const ACCOUNT_EXISTS = new Set(['user_already_exists', 'email_exists']);

interface Credentials {
  email: string;
  password: string;
  /** The Turnstile token, when this deployment uses Auth's CAPTCHA (see `useAuthCaptcha`). */
  captchaToken?: string | undefined;
}

/** Auth's `options.captchaToken`, present only when there is a token to send. */
function captcha(captchaToken: string | undefined) {
  return captchaToken ? { captchaToken } : {};
}

/** Signs in with email and password. */
export function useSignIn() {
  return useMutation({
    mutationFn: async ({ email, password, captchaToken }: Credentials) => {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
        options: captcha(captchaToken),
      });
      if (error) throw error;
    },
  });
}

/**
 * Creates an account and emails a confirmation link that signs the user in. Succeeds for an
 * email that already has an account too, so the screen can't be used to find out who has one.
 */
export function useSignUp() {
  return useMutation({
    mutationFn: async ({ email, password, captchaToken, next }: Credentials & { next: string }) => {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: callbackUrl(next), ...captcha(captchaToken) },
      });
      if (error && !ACCOUNT_EXISTS.has(error.code ?? '')) throw error;
    },
  });
}

/**
 * Sends the sign-up confirmation email again. Reports success for an address that has no
 * pending sign-up (already confirmed, or unknown) so it can't be used to find out who has an
 * account. Auth throttles repeats (`rate_limited`).
 */
export function useResendConfirmation() {
  return useMutation({
    mutationFn: async ({
      email,
      next,
      captchaToken,
    }: {
      email: string;
      next: string;
      captchaToken?: string | undefined;
    }) => {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: callbackUrl(next), ...captcha(captchaToken) },
      });
      if (error && !ACCOUNT_EXISTS.has(error.code ?? '')) throw error;
    },
  });
}

/**
 * Emails a one-time sign-in link to an existing account. An unknown email also reports
 * success, for the same reason as `useSignUp`; new accounts go through sign-up.
 */
export function useSendSignInLink() {
  return useMutation({
    mutationFn: async ({
      email,
      next,
      captchaToken,
    }: {
      email: string;
      next: string;
      captchaToken?: string | undefined;
    }) => {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: callbackUrl(next),
          ...captcha(captchaToken),
        },
      });
      if (error && error.code !== 'otp_disabled') throw error;
    },
  });
}

/**
 * Emails a password-recovery code and link. An unknown email also reports success, for the same
 * reason as `useSignUp`. The link and the code both end in a session on `/auth/reset-password`.
 */
export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: async ({
      email,
      captchaToken,
    }: {
      email: string;
      captchaToken?: string | undefined;
    }) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: callbackUrl(RESET_PATH),
        ...captcha(captchaToken),
      });
      if (error) throw error;
    },
  });
}

/**
 * Sets a new password for the signed-in user, which after a recovery link or code is the
 * recovery session. Errors: `weak_password`, `same_password`.
 */
export function useSetPassword() {
  return useMutation({
    mutationFn: async (password: string) => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    },
  });
}

/**
 * Changes the signed-in user's password. The current password is checked first by signing in with
 * it, which also makes the session recent enough for Auth's `secure_password_change`; other
 * devices are then signed out. Errors: `wrong_password`, `weak_password`, `same_password`.
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: async ({
      currentPassword,
      newPassword,
      captchaToken,
    }: {
      currentPassword: string;
      newPassword: string;
      captchaToken?: string | undefined;
    }) => {
      const { data } = await supabase.auth.getSession();
      const email = data.session?.user.email;
      if (!email) throw Object.assign(new Error('signed out'), { code: 'link_invalid' });
      const check = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
        options: captcha(captchaToken),
      });
      if (check.error)
        throw check.error.code === 'invalid_credentials'
          ? Object.assign(check.error, { code: 'wrong_password' })
          : check.error;
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      // Best effort: the new password is already set, so a failure here isn't the user's problem.
      await supabase.auth.signOut({ scope: 'others' });
    },
  });
}

/**
 * Digits in an emailed sign-in code. Must match `otp_length` under `[auth.email]` in
 * supabase/config.toml (and the hosted project's setting): 8 digits, because GoTrue doesn't rate
 * limit wrong guesses per code (security review of #509).
 */
export const SIGN_IN_CODE_LENGTH = 8;

/**
 * Signs in with the code from a sign-in (`email`), confirmation (`signup`) or recovery email. Unlike
 * the emailed link, which PKCE ties to the browser that asked for it, the code works on whatever
 * screen it's typed into. A wrong, used or expired code fails as `code_invalid`.
 */
export function useVerifyCode() {
  return useMutation({
    mutationFn: async ({
      email,
      code,
      type,
    }: {
      email: string;
      code: string;
      type: 'email' | 'signup' | 'recovery';
    }) => {
      const { error } = await supabase.auth.verifyOtp({ email, token: code, type });
      if (error)
        throw error.code === 'otp_expired' ? Object.assign(error, { code: 'code_invalid' }) : error;
    },
  });
}

/** Signs out this device only, so a shared tablet doesn't end the owner's other sessions. */
export function useSignOut() {
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    },
  });
}

/**
 * Accepts a staff invitation for the signed-in user (`api.accept_invitation`). Repeating it for the
 * same user succeeds. Errors: `not_found` for an unknown, used, expired or revoked token or an
 * invitation sent to another email address.
 */
export function useAcceptInvitation() {
  return useMutation({
    mutationFn: async (token: string) => {
      const { data, error } = await supabase.rpc('accept_invitation', { p_token: token });
      if (error) throw new Error(errorCode(error));
      return data;
    },
    onSuccess: async () => {
      // The invitation email's wording came from these; leave none behind to colour later mail.
      await supabase.auth
        .updateUser({ data: { invite_org: null, invite_by: null } })
        .catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
    },
  });
}

/**
 * Signs in with the session an Auth email link put in the URL fragment. PKCE, which every other
 * link here uses, needs the browser that asked for the link; an invitation is created by an admin
 * on the server, so its link (and the magic link for an existing account) carries tokens instead
 * (`type=invite` or `type=magiclink`). Anything else in the fragment is ignored, and the fragment
 * is removed from the address either way. Resolves true when a session was set.
 */
export function adoptSessionFromFragment(): Promise<boolean> {
  // Once per page load: React runs effects twice in development, and the fragment is gone by then.
  adopting ??= adoptFragment();
  return adopting;
}

let adopting: Promise<boolean> | null = null;

async function adoptFragment(): Promise<boolean> {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has('access_token')) return false;
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const type = params.get('type');
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  if (!accessToken || !refreshToken || (type !== 'invite' && type !== 'magiclink')) return false;
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) return false;
  // A getSession() that started before the fragment was adopted may still resolve with null.
  await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
  return true;
}

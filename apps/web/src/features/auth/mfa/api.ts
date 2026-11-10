import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { sessionQuery } from '../api.ts';

// PLT11 (#417): authenticator-app (TOTP) MFA through Supabase Auth. Screens use these hooks and
// never call `supabase.auth.mfa` themselves. The phase 2a owner MFA reuses them.

/** Digits an authenticator app shows. Fixed by Supabase Auth. */
export const TOTP_CODE_LENGTH = 6;

export interface MfaStatus {
  /** `aal2` once this session has passed a TOTP check. */
  level: 'aal1' | 'aal2';
  /** The first verified TOTP factor, or null when the account has none yet. */
  factorId: string | null;
  /** Every verified TOTP factor, oldest first. */
  factors: { id: string; name: string }[];
}

export const mfaStatusQuery = queryOptions({
  queryKey: ['auth', 'mfa'],
  queryFn: async (): Promise<MfaStatus> => {
    const [aal, factors] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ]);
    if (aal.error) throw aal.error;
    if (factors.error) throw factors.error;
    return {
      level: aal.data.currentLevel === 'aal2' ? 'aal2' : 'aal1',
      factorId: factors.data.totp[0]?.id ?? null,
      factors: factors.data.totp.map((f) => ({ id: f.id, name: f.friendly_name ?? '' })),
    };
  },
});

/**
 * True when the account has a verified factor this session hasn't used yet (aal1 now, aal2
 * available): staff and admin routes ask for the code first.
 */
export async function needsMfaChallenge(): Promise<boolean> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return !error && data.currentLevel !== 'aal2' && data.nextLevel === 'aal2';
}

export interface Enrolment {
  factorId: string;
  /** An SVG data URL of the otpauth:// link, for the authenticator app to scan. */
  qrCode: string;
  /** The same secret as text, for typing in when scanning isn't possible. */
  secret: string;
}

/**
 * Starts adding an authenticator app. Unfinished enrolments from earlier attempts are removed
 * first, so retrying never hits the factor limit. Finish with `useVerifyTotp`.
 */
export function useEnrolTotp() {
  return useMutation({
    mutationFn: async (): Promise<Enrolment> => {
      const listed = await supabase.auth.mfa.listFactors();
      if (listed.error) throw listed.error;
      for (const factor of listed.data.all) {
        if (factor.factor_type === 'totp' && factor.status === 'unverified') {
          const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
          if (error) throw error;
        }
      }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (error) throw error;
      return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
    },
  });
}

/**
 * One TOTP check. When the lockout hook rejects a code, Auth also ends the session on the server,
 * so this drops it locally too and the operator signs in again after the wait.
 */
async function checkCode(factorId: string, code: string) {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (!error) return;
  if (error.code === 'mfa_verification_rejected') await supabase.auth.signOut({ scope: 'local' });
  throw error;
}

/**
 * Checks a code from the authenticator app. On success the session becomes aal2 (and a new
 * enrolment becomes the account's factor). A wrong code fails as `totp_invalid`; five wrong codes
 * in 15 minutes lock the account's codes as `totp_locked` and sign it out, and Auth's per-IP limit answers
 * `rate_limited`. Whatever fails, the session stays aal1.
 */
export function useVerifyTotp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ factorId, code }: { factorId: string; code: string }) =>
      checkCode(factorId, code),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries(sessionQuery),
        queryClient.invalidateQueries(mfaStatusQuery),
      ]),
  });
}

/**
 * Removes the authenticator app after checking a fresh code from it, so an unattended signed-in
 * browser can't strip the second factor. Errors as `useVerifyTotp`.
 */
export function useUnenrolTotp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ factorId, code }: { factorId: string; code: string }) => {
      await checkCode(factorId, code);
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw error;
      // The session still claims aal2 until it refreshes; refresh so it matches the account.
      await supabase.auth.refreshSession();
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries(sessionQuery),
        queryClient.invalidateQueries(mfaStatusQuery),
      ]),
  });
}

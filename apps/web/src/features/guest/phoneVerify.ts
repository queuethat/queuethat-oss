import { useMutation, useQueryClient } from '@tanstack/react-query';
import { read, store } from './api.ts';
import { requestPhoneCode } from './captcha/publicJoin.ts';
import { guestRpc } from './client.ts';

// Kept out of api.ts so the status route loads it only when a guest has texts on (guest JS budget).

const verifiedKey = (token: string) => `qm:phone-verified:${token}`;
/** True once this phone confirmed its number, so the status page stops offering the code box. */
export const phoneVerified = (token: string) => read(verifiedKey(token)) === '1';

/** Asks for a code. `captcha` is single-use: the caller solves a fresh one per request. */
export function useRequestPhoneCode(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (captcha: string) => requestPhoneCode(token, captcha),
    onSuccess: async (result) => {
      if (result.state !== 'verified') return;
      store(verifiedKey(token), '1');
      await queryClient.invalidateQueries({ queryKey: ['guest', 'visit', token] });
    },
  });
}

/** Checks the typed code; resolves to 'verified' or 'invalid' (the database does not say why). */
export function useVerifyPhoneCode(token: string) {
  return useMutation({
    mutationFn: async (code: string) => {
      const result = await guestRpc('guest_verify_phone_code', { p_token: token, p_code: code });
      if (result.state === 'verified') store(verifiedKey(token), '1');
      return result.state;
    },
  });
}

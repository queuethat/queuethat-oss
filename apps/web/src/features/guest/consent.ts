import { consentText, sha256Hex, type ConsentBusiness } from '@qm/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { guestRpc } from './client.ts';
import { read, store } from './api.ts';

// Kept out of api.ts so the join route loads it only when a guest ticks the opt-in (guest JS budget).

/**
 * Records the guest's consent to texts about this visit (3-CG6): the newest published opt-in text
 * for their language, with the sha256 of the exact words shown. The server re-renders and refuses
 * a different hash, so the page and the database cannot drift apart.
 */
export async function grantTextConsent(token: string, business: ConsentBusiness, locale: string) {
  const shown = consentText('sms', locale, business) ?? consentText('sms', 'en', business);
  if (!shown) throw new Error('no_consent_text');
  return guestRpc('guest_grant_consent', {
    p_token: token,
    p_channel: 'sms',
    p_text_version: shown.version,
    p_text_hash: await sha256Hex(shown.text),
    p_locale: shown.locale,
  });
}

/** Set when a join's consent call failed, so the status page can say texts are off and offer a retry. */
const consentFailedKey = (token: string) => `qm:consent-failed:${token}`;
export const markConsentFailed = (token: string) => store(consentFailedKey(token), '1');
export const consentFailed = (token: string) => read(consentFailedKey(token)) === '1';
export const clearConsentFailed = (token: string) => store(consentFailedKey(token), null);

/** Turns texts on from the status page. Refreshes the visit so `text_consent` flips to on. */
export function useGrantTextConsent(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ business, locale }: { business: ConsentBusiness; locale: string }) =>
      grantTextConsent(token, business, locale),
    onSuccess: async () => {
      clearConsentFailed(token);
      await queryClient.invalidateQueries({ queryKey: ['guest', 'visit', token] });
    },
  });
}

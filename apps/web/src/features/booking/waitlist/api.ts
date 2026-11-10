import { errorCode } from '@qm/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { joinPass } from '../../guest/api.ts';
import { guestRpc } from '../../guest/client.ts';
import { attemptKey, store, type BookingResult } from '../api.ts';

// The slot waitlist (A-9): one hook per RPC (apps/web/README.md).

/** api.waitlist_status */
export interface WaitlistStatus {
  status: 'waiting' | 'offered' | 'claimed' | 'expired' | 'cancelled';
  service_name: string;
  location_name: string;
  location_slug: string;
  wanted_day: string;
  slot_start: string | null;
  slot_end: string | null;
  offer_expires_at: string | null;
  as_of: string;
}

export interface JoinWaitlistInput {
  slug: string;
  serviceId: string;
  day: string;
  windowStart: string | null;
  windowEnd: string | null;
  name: string;
  phoneE164: string | null;
  email: string;
  /** Turnstile token, when the deployment asks for one (the booking page's `captchaSiteKey`). */
  captchaToken?: string | null;
}

/** Joins the waitlist for a day. The key lives in localStorage until it succeeds, so a retry is one entry. */
export function useJoinWaitlist() {
  return useMutation({
    mutationFn: async (input: JoinWaitlistInput): Promise<string> => {
      const keyName = `qm:waitlist-key:${input.slug}:${input.serviceId}:${input.day}`;
      const token = (await guestRpc('guest_join_waitlist', {
        p_location_slug: input.slug,
        p_service_id: input.serviceId,
        p_wanted_day: input.day,
        p_window_start: input.windowStart,
        p_window_end: input.windowEnd,
        p_name: input.name,
        p_phone_e164: input.phoneE164,
        p_email: input.email,
        p_idempotency_key: attemptKey(keyName),
        p_join_pass: input.captchaToken ? await joinPass(input.captchaToken) : null,
      })) as unknown as string;
      store(keyName, null);
      return token;
    },
  });
}

/** The entry behind a waitlist token; unknown and long-ended tokens are both not_found. */
export function useWaitlistEntry(token: string) {
  return useQuery({
    queryKey: ['booking', 'waitlist', token],
    queryFn: async () =>
      (await guestRpc('guest_get_waitlist', { p_token: token })) as unknown as WaitlistStatus,
    // An open offer is time-boxed, so keep it fresh.
    refetchInterval: (q) => (q.state.data?.status === 'offered' ? 15_000 : false),
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
  });
}

/** Claims the held slot. The token is the appointment's token too, so the caller goes to /a/:token. */
export function useClaimOffer(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await guestRpc('guest_claim_offer', {
        p_token: token,
        p_idempotency_key: attemptKey(`qm:claim-key:${token}`),
      })) as unknown as BookingResult,
    onSuccess: () => {
      store(`qm:claim-key:${token}`, null);
      return queryClient.invalidateQueries({ queryKey: ['booking', 'waitlist', token] });
    },
  });
}

export function useLeaveWaitlist(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await guestRpc('guest_leave_waitlist', { p_token: token });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['booking', 'waitlist', token] }),
  });
}

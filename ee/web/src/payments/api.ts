// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@app/lib/supabase.ts';
import { visitPaymentsKey } from '@app/features/console/payments/api.ts';

/**
 * Asks the visit's guest to pay at the counter (4-PAY1). The guest's status page shows the amount
 * and takes the card; a repeated tap with the same key is one request.
 */
export function useRequestPayment(visitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { amountMinor: number; currency: string }) => {
      const { error } = await supabase.rpc('staff_request_payment', {
        p_visit_id: visitId,
        p_amount_minor: input.amountMinor,
        p_currency: input.currency,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: visitPaymentsKey(visitId) }),
  });
}

export interface PayCode {
  /** Eight characters from an alphabet without look-alikes; shown as two halves. */
  code: string;
  expiresAt: string;
}

/**
 * Mints the short code that opens the card form for the visit's open counter payment (4-PAY2), for
 * the tablet to show as a QR. Asking again replaces the earlier code. The server never returns it
 * again, so the caller keeps it only while it is on screen.
 */
export function useCreatePayCode(visitId: string) {
  return useMutation({
    mutationFn: async (): Promise<PayCode> => {
      const { data, error } = await supabase.rpc('staff_create_pay_code', { p_visit_id: visitId });
      if (error) throw error;
      if (!data.code || !data.expires_at) throw new Error('pay_code');
      return { code: data.code, expiresAt: data.expires_at };
    },
  });
}

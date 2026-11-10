import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

// Payment policy of one service (A-13): who pays what to book. Read by staff and written by
// managers under RLS; the database derives the location from the service and audits every change.

export type PaymentMode = 'none' | 'deposit' | 'hold';
export type ReleaseAfter = 'served' | 'checked_in';

export interface PaymentPolicy {
  mode: PaymentMode;
  amountMinor: number;
  currency: string;
  releaseAfter: ReleaseAfter;
  cancelCutoffHours: number;
}

/** What a service without a policy row has: no payment. */
export const DEFAULT_PAYMENT_POLICY: PaymentPolicy = {
  mode: 'none',
  amountMinor: 0,
  currency: 'usd',
  releaseAfter: 'served',
  cancelCutoffHours: 24,
};

const key = (serviceId: string) => ['admin', 'payment-policy', serviceId];

export const paymentPolicyQuery = (serviceId: string) =>
  queryOptions({
    queryKey: key(serviceId),
    queryFn: async (): Promise<PaymentPolicy> => {
      const { data, error } = await supabase
        .schema('app')
        .from('payment_policies')
        .select('mode, amount_minor, currency, release_after, cancel_cutoff_hours')
        .eq('service_id', serviceId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return DEFAULT_PAYMENT_POLICY;
      return {
        mode: data.mode as PaymentMode,
        amountMinor: Number(data.amount_minor),
        currency: data.currency,
        releaseAfter: data.release_after as ReleaseAfter,
        cancelCutoffHours: data.cancel_cutoff_hours,
      };
    },
  });

export function useSavePaymentPolicy(target: {
  orgId: string;
  locationId: string;
  serviceId: string;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (p: PaymentPolicy) => {
      const { error } = await supabase
        .schema('app')
        .from('payment_policies')
        .upsert(
          {
            org_id: target.orgId,
            location_id: target.locationId,
            service_id: target.serviceId,
            mode: p.mode,
            // The table requires a positive amount only when a payment is asked for.
            amount_minor: p.mode === 'none' ? 0 : p.amountMinor,
            currency: p.currency,
            release_after: p.releaseAfter,
            cancel_cutoff_hours: p.cancelCutoffHours,
          },
          { onConflict: 'org_id,service_id' },
        );
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(target.serviceId) }),
  });
}

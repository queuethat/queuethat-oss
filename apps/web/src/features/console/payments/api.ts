import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

// Payments of one visit (A-13), read under RLS (staff of the location) and changed only through
// the manager-only api.staff_charge_no_show and api.staff_refund_payment.

export interface VisitPayment {
  id: string;
  kind: 'hold' | 'deposit' | 'card_on_file' | 'no_show_fee' | 'pos';
  status: string;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
}

export type PaymentBadge =
  'requires_action' | 'held' | 'paid' | 'card_on_file' | 'released' | 'refunded' | 'failed';

/** Which badge a payment shows; the status itself comes from the database. */
export function badgeOf(p: Pick<VisitPayment, 'kind' | 'status'>): PaymentBadge {
  switch (p.status) {
    case 'authorized':
      return p.kind === 'card_on_file' ? 'card_on_file' : 'held';
    case 'succeeded':
    case 'captured':
      return 'paid';
    case 'released':
    case 'refunded':
    case 'failed':
      return p.status;
    default:
      return 'requires_action';
  }
}

/** The query key of one visit's payments, for invalidation. */
export const visitPaymentsKey = (visitId: string) => ['console', 'payments', visitId];

export const visitPaymentsQuery = (visitId: string) =>
  queryOptions({
    queryKey: visitPaymentsKey(visitId),
    queryFn: async (): Promise<VisitPayment[]> => {
      const appointments = await supabase
        .schema('app')
        .from('appointments')
        .select('id')
        .eq('visit_id', visitId);
      if (appointments.error) throw appointments.error;
      const ids = appointments.data.map((a) => a.id);
      const filter = [
        `visit_id.eq.${visitId}`,
        ...(ids.length ? [`appointment_id.in.(${ids.join(',')})`] : []),
      ];
      const { data, error } = await supabase
        .schema('app')
        .from('payments')
        .select('id, kind, status, amount_minor, refunded_minor, currency')
        .or(filter.join(','))
        .order('created_at');
      if (error) throw error;
      return data.map((p) => ({
        id: p.id,
        kind: p.kind as VisitPayment['kind'],
        status: p.status,
        amountMinor: Number(p.amount_minor),
        refundedMinor: Number(p.refunded_minor),
        currency: p.currency,
      }));
    },
  });

export function useChargeNoShow(visitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (paymentId: string) => {
      const { error } = await supabase.rpc('staff_charge_no_show', {
        p_payment_id: paymentId,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: visitPaymentsKey(visitId) }),
  });
}

export function useRefundPayment(visitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { paymentId: string; amountMinor: number; reason: string }) => {
      const { error } = await supabase.rpc('staff_refund_payment', {
        p_payment_id: input.paymentId,
        p_amount_minor: input.amountMinor,
        p_reason: input.reason,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: visitPaymentsKey(visitId) }),
  });
}

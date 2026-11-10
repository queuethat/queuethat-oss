// The Supabase side of payment-intent; index.ts passes Deno's supabase-js.
import { PlanError, type PaymentIntentDeps } from './handler.ts';

// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; serviceRoleKey: string },
): Pick<PaymentIntentDeps, 'begin' | 'beginPos' | 'beginPosByCode' | 'attach' | 'hit' | 'digest'> {
  const client = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const api = client.schema('api');
  return {
    async begin(token, provider, idempotencyKey) {
      const { data, error } = await api.rpc('begin_payment', {
        p_token: token, p_provider: provider, p_idempotency_key: idempotencyKey,
      });
      if (error?.message === 'not_found' || error?.message === 'payment_not_required') throw new PlanError(error.message);
      if (error) throw new Error('begin_payment');
      const row = Array.isArray(data) ? data[0] : data;
      // begin_payment's signature stays as #364 shipped it; the policy snapshot is read off the payment.
      const { data: snapshot, error: snapshotError } = await client
        .schema('app').from('payments').select('cancel_cutoff_hours, release_after').eq('id', row.payment_id).single();
      if (snapshotError || !snapshot) throw new Error('payment_snapshot');
      return {
        cancel_cutoff_hours: Number(snapshot.cancel_cutoff_hours), release_after: snapshot.release_after,
        payment_id: row.payment_id, org_id: row.org_id, kind: row.kind, amount_minor: Number(row.amount_minor),
        currency: row.currency, ref_id: row.ref_id,
      };
    },
    async beginPos(token, provider) {
      const { data, error } = await api.rpc('begin_pos_payment', { p_token: token, p_provider: provider });
      if (error?.message === 'not_found' || error?.message === 'payment_not_required') throw new PlanError(error.message);
      if (error) throw new Error('begin_pos_payment');
      const row = Array.isArray(data) ? data[0] : data;
      return {
        payment_id: row.payment_id, org_id: row.org_id, kind: row.kind, amount_minor: Number(row.amount_minor),
        currency: row.currency, ref_id: row.ref_id, cancel_cutoff_hours: Number(row.cancel_cutoff_hours),
        release_after: row.release_after,
      };
    },
    async beginPosByCode(code, provider) {
      const { data, error } = await api.rpc('begin_pos_payment_by_code', { p_code: code, p_provider: provider });
      if (error?.message === 'not_found' || error?.message === 'payment_not_required') throw new PlanError(error.message);
      if (error) throw new Error('begin_pos_payment_by_code');
      const row = Array.isArray(data) ? data[0] : data;
      return {
        payment_id: row.payment_id, org_id: row.org_id, kind: row.kind, amount_minor: Number(row.amount_minor),
        currency: row.currency, ref_id: row.ref_id, cancel_cutoff_hours: Number(row.cancel_cutoff_hours),
        release_after: row.release_after,
      };
    },
    async attach(paymentId, intentId, setupIntentId) {
      const { error } = await api.rpc('attach_payment_intent', {
        p_payment_id: paymentId, p_intent_id: intentId, p_setup_intent_id: setupIntentId,
      });
      if (error) throw new Error('attach_payment_intent');
    },
    async hit(key, limit, windowSeconds) {
      const { data, error } = await api.rpc('hit_rate_limit', { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
      if (error) throw new Error('hit_rate_limit');
      return data === true;
    },
    async digest(value) {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    },
  };
}

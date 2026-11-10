// payment-jobs entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { FakePaymentProvider, StripePaymentProvider } from '@qm/providers';
import { logInfo } from '../_shared/log.ts';
import { createPaymentJobsHandler, type PaymentJob, type StoredPayment } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const client = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const api = client.schema('api');
const stripe = Deno.env.get('STRIPE_SECRET_KEY');
const provider = stripe
  ? new StripePaymentProvider({
    secretKey: stripe,
    webhookSecret: Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '',
    live: Deno.env.get('PAYMENTS_LIVE') === 'true',
  })
  : Deno.env.get('PAYMENT_PROVIDER') === 'fake'
  ? new FakePaymentProvider('unused')
  : (() => {
    throw new Error('Set STRIPE_SECRET_KEY, or PAYMENT_PROVIDER=fake for local use');
  })();

Deno.serve(createPaymentJobsHandler({
  provider,
  secret: env('DISPATCH_SECRET'),
  async claim(limit, leaseSeconds) {
    const { data, error } = await api.rpc('claim_payment_jobs', { p_limit: limit, p_lease_seconds: leaseSeconds });
    if (error) throw new Error('claim_payment_jobs');
    return (data ?? []) as unknown as PaymentJob[];
  },
  async payment(id) {
    const { data, error } = await client.schema('app').from('payments')
      .select('kind, intent_id, customer_id, payment_method_id, amount_minor, currency, org_id').eq('id', id).maybeSingle();
    if (error) throw new Error('payment lookup');
    return data as StoredPayment | null;
  },
  async report(jobId, result) {
    const { error } = await api.rpc('report_payment_result', { p_job_id: jobId, p_result: result });
    if (error) throw new Error('report_payment_result');
  },
  log: (line) => logInfo(line),
}));

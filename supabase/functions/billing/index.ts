// billing entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { FakeBillingProvider, StripeBillingProvider } from '@qm/providers';
import { createObserver } from '../_shared/observe.ts';
import { createBillingHandler, type BillingJob, SessionError } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const url = env('SUPABASE_URL');
const api = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('api');
const observe = createObserver('billing', Deno.env.get('SENTRY_DSN'));

// The platform's own Stripe account in test mode. The fake only when explicitly asked for, so a
// deployment missing its Stripe key fails at boot, not open.
const provider = Deno.env.get('STRIPE_BILLING_SECRET_KEY')
  ? new StripeBillingProvider({
    secretKey: env('STRIPE_BILLING_SECRET_KEY'),
    webhookSecret: env('STRIPE_BILLING_WEBHOOK_SECRET'),
    live: Deno.env.get('BILLING_LIVE') === 'true',
    // Comma-separated Stripe Price ids of the per-location plan (monthly, annual). Optional until a second item exists.
    locationPriceIds: (Deno.env.get('STRIPE_LOCATION_PRICE_IDS') ?? '').split(',').map((v) => v.trim()).filter(Boolean),
    // Stripe Price id of the monthly SMS bundle: a paid invoice carrying it grants credit.
    bundlePriceId: Deno.env.get('STRIPE_BUNDLE_PRICE_ID')?.trim() || undefined,
  })
  : Deno.env.get('BILLING_PROVIDER') === 'fake'
  ? new FakeBillingProvider(env('FAKE_BILLING_WEBHOOK_SECRET'))
  : (() => {
    throw new Error('Set STRIPE_BILLING_SECRET_KEY and STRIPE_BILLING_WEBHOOK_SECRET, or BILLING_PROVIDER=fake for local use');
  })();

Deno.serve(
  observe.serve(createBillingHandler({
    provider,
    secret: env('DISPATCH_SECRET'),
    publicUrl: env('PUBLIC_URL'),
    async sessionInfo(token, orgId, interval) {
      // The caller's own JWT: the database decides whether they are this org's owner.
      const user = createClient(url, env('SUPABASE_ANON_KEY'), {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      }).schema('api');
      const { data, error } = await user.rpc('billing_session_info', { p_org_id: orgId, p_interval: interval });
      if (error) {
        const code = error.code === '42501' ? 'permission_denied' : error.message === 'not_found' ? 'not_found' : null;
        throw code ? new SessionError(code) : error.code === 'PGRST301' || error.code === '401' ? new SessionError('unauthorized') : new Error('billing_session_info');
      }
      const row = data?.[0];
      if (!row) throw new SessionError('not_found');
      return {
        customerId: row.customer_id,
        subscriptionId: row.subscription_id,
        priceId: row.price_id,
        quantity: row.quantity ?? 1,
      };
    },
    async apply(event) {
      if (event.type === 'topup') {
        const { data, error } = await api.rpc('apply_credit_topup', {
          p_session_id: event.sessionId,
          p_org_id: event.orgId ?? '00000000-0000-0000-0000-000000000000',
          p_amount_minor: event.amountMinor,
          p_currency: event.currency,
        });
        if (error) throw new Error('apply_credit_topup');
        return data as string;
      }
      if (event.type === 'bundle_paid') {
        const { data, error } = await api.rpc('apply_bundle_grant', {
          p_invoice_id: event.invoiceId,
          p_subscription_id: event.subscriptionId,
          p_created: event.at,
        });
        if (error) throw new Error('apply_bundle_grant');
        return data as string;
      }
      const paid = event.type === 'payment_failed' ? null : event;
      const { data, error } = await api.rpc('apply_billing_event', {
        p_type: event.type,
        p_created: event.at,
        p_org_id: paid?.orgId ?? null,
        p_customer_id: event.customerId ?? null,
        p_subscription_id: event.subscriptionId,
        p_status: paid?.status ?? null,
        p_price_id: paid?.priceId ?? null,
        p_quantity: paid?.quantity ?? null,
        p_period_end: paid?.periodEnd ?? null,
      });
      if (error) throw new Error('apply_billing_event'); // never the message: it can carry Stripe ids
      return data as string;
    },
    async claim(limit, leaseSeconds) {
      const { data, error } = await api.rpc('claim_billing_jobs', { p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw new Error('claim_billing_jobs');
      return (data ?? []) as unknown as BillingJob[];
    },
    async report(jobId, result) {
      const { error } = await api.rpc('report_billing_result', { p_job_id: jobId, p_result: result });
      if (error) throw new Error('report_billing_result');
    },
    log: observe.log,
    error: observe.error,
  })),
);

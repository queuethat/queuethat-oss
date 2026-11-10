// payment-webhook entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { FakePaymentProvider, StripePaymentProvider } from '@qm/providers';
import { createObserver } from '../_shared/observe.ts';
import { createPaymentWebhookHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const api = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('api');
const observe = createObserver('payment-webhook', Deno.env.get('SENTRY_DSN'));

// Stripe test mode when its keys are set. The fake (signed with FAKE_PAYMENT_WEBHOOK_SECRET) only
// when explicitly asked for, so a deployment missing its Stripe key fails at boot, not open.
const useFake = Deno.env.get('PAYMENT_PROVIDER') === 'fake' || Deno.env.get('PAYMENTS_DEV') === 'true';
const provider = Deno.env.get('STRIPE_SECRET_KEY')
  ? new StripePaymentProvider({
    secretKey: env('STRIPE_SECRET_KEY'),
    webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    live: Deno.env.get('PAYMENTS_LIVE') === 'true',
  })
  : useFake
  ? new FakePaymentProvider(env('FAKE_PAYMENT_WEBHOOK_SECRET'))
  : (() => {
    throw new Error('Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, or PAYMENT_PROVIDER=fake for local use');
  })();

Deno.serve(
  observe.serve(createPaymentWebhookHandler({
    provider,
    async record(providerName, event) {
      const { data, error } = await api.rpc('record_payment_event', {
        p_provider: providerName,
        p_event_id: event.eventId,
        p_type: event.type,
        p_provider_hold_id: event.holdId,
        p_amount_minor: event.type === 'captured' ? event.amountMinor : null,
        p_at: event.at,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    log: observe.log,
    error: observe.error,
  })),
);

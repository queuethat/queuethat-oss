// payment-intent entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { FakePaymentProvider, StripePaymentProvider } from '@qm/providers';
import { createObserver } from '../_shared/observe.ts';
import { supabaseDeps } from './deps.ts';
import { createPaymentIntentHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('payment-intent', Deno.env.get('SENTRY_DSN'));
// Stripe test mode when its key is set; the fake only when asked for, so a missing key fails at boot.
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

Deno.serve(
  observe.serve(createPaymentIntentHandler({
    ...supabaseDeps(createClient, { url: env('SUPABASE_URL'), serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY') }),
    provider,
    publishableKey: Deno.env.get('STRIPE_PUBLISHABLE_KEY') ?? '',
    publicUrl: env('PUBLIC_URL'),
    error: observe.error,
  })),
);

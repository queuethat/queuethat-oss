// LOCAL TESTING ONLY (#318): creates a test-mode hold so the webhook loop can be exercised end to
// end. Off (404) unless PAYMENTS_DEV=true, which no hosted environment sets. The caller's JWT is
// forwarded for the visit lookup, so RLS limits it to visits the caller's org staff can read.
// POST { visit_id, amount_minor, currency }  ->  { hold_id, client_secret }
import { createClient } from '@supabase/supabase-js';
import { FakePaymentProvider, StripePaymentProvider } from '@qm/providers';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const provider = Deno.env.get('STRIPE_SECRET_KEY')
  ? new StripePaymentProvider({ secretKey: env('STRIPE_SECRET_KEY'), webhookSecret: Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '' })
  : new FakePaymentProvider('unused');

Deno.serve(async (req) => {
  if (Deno.env.get('PAYMENTS_DEV') !== 'true' || req.method !== 'POST') return new Response(null, { status: 404 });
  const body = await req.json().catch(() => null);
  const { visit_id: visitId, amount_minor: amountMinor, currency } = body ?? {};
  if (typeof visitId !== 'string' || !Number.isInteger(amountMinor) || amountMinor <= 0 || typeof currency !== 'string') {
    return Response.json({ error: 'invalid_input' }, { status: 400 });
  }
  const asCaller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: visit } = await asCaller.schema('app').from('visits').select('id, org_id').eq('id', visitId).maybeSingle();
  if (!visit) return Response.json({ error: 'not_found' }, { status: 404 });
  const idempotencyKey = `dev:${visit.id}:${amountMinor}:${currency}`;
  const hold = await provider.createHold({ orgId: visit.org_id, amountMinor, currency, refId: visitId, idempotencyKey });
  const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  }).schema('api');
  const { error } = await service.rpc('create_payment_hold', {
    p_org_id: visit.org_id, p_visit_id: visit.id, p_appointment_id: null, p_provider: provider.providerName,
    p_provider_hold_id: hold.intentId, p_amount_minor: amountMinor, p_currency: currency, p_idempotency_key: idempotencyKey,
  });
  if (error) return Response.json({ error: 'unknown' }, { status: 500 });
  return Response.json({ hold_id: hold.intentId, client_secret: hold.clientSecret });
});

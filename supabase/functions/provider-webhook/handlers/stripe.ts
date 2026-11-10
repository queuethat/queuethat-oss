// 3-PAY4 (#365): Stripe events become payment state. Registered under `stripe` in index.ts. The
// signature check and event-id de-duplication already happened in provider-webhook; the monotonic
// ordering and the org cross-check live in api.apply_payment_event (one owner for the rule).
import type { WebhookHandler } from '../handler.ts';

export type PaymentEventType = 'authorized' | 'succeeded' | 'canceled' | 'failed' | 'setup_succeeded' | 'refunded';

export interface PaymentEventArgs {
  orgId: string;
  type: PaymentEventType;
  objectId: string;
  metaOrg: string | null;
  amountMinor: number | null;
  customerId: string | null;
  paymentMethodId: string | null;
}

/** api.apply_payment_event: applied, ignored, unknown_intent or org_mismatch. */
export type ApplyPaymentEvent = (args: PaymentEventArgs) => Promise<string>;

const TYPES: Record<string, PaymentEventType> = {
  'payment_intent.amount_capturable_updated': 'authorized',
  'payment_intent.succeeded': 'succeeded',
  'payment_intent.canceled': 'canceled',
  'payment_intent.payment_failed': 'failed',
  'setup_intent.succeeded': 'setup_succeeded',
  'charge.refunded': 'refunded',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const str = (v: unknown) => (typeof v === 'string' && v !== '' && v.length <= 200 ? v : null);

export function stripePaymentHandler(
  apply: ApplyPaymentEvent,
  log: (line: string) => void = () => {},
): WebhookHandler {
  return async ({ orgId, rawBody }) => {
    if (!orgId) return;
    let event: { type?: unknown; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return;
    }
    const type = typeof event.type === 'string' ? TYPES[event.type] : undefined;
    const obj = event.data?.object;
    if (!type || !obj) return; // events we don't act on are acknowledged
    const objectId = str(type === 'refunded' ? obj.payment_intent : obj.id);
    if (!objectId) return;
    const meta = (obj.metadata ?? {}) as Record<string, unknown>;
    const rawMeta = str(meta.org_id);
    // A metadata org that isn't even a uuid can't match the endpoint's: pass the nil uuid so it mismatches.
    const metaOrg = rawMeta === null ? null : UUID.test(rawMeta) ? rawMeta : '00000000-0000-0000-0000-000000000000';
    const result = await apply({
      orgId,
      type,
      objectId,
      metaOrg,
      amountMinor: type === 'refunded' && Number.isInteger(obj.amount_refunded) ? (obj.amount_refunded as number) : null,
      customerId: str(obj.customer),
      paymentMethodId: str(obj.payment_method),
    });
    if (result === 'unknown_intent') log(`stripe ${event.type}: no payment for that intent in this org`);
    if (result === 'org_mismatch') log(`stripe ${event.type}: metadata org differs from the endpoint org, ignored`);
  };
}

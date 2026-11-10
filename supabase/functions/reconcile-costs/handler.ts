// 3-SMS2 (#351): reconcile-costs. SMS are priced from our rate table when sent; Twilio fills the
// real `price` on the Message resource some time later. pg_cron kicks this every 10 minutes
// (ops.kick_reconcile_costs): it takes up to 100 estimated rows, asks Twilio for each price and
// stores it as cost_source 'provider'. Rows are given up on after 48 h by the query itself.
// Everything external is injected, so the tests run with fakes.
//
// POST (Authorization: Bearer <DISPATCH_SECRET>)   200 { checked, priced, skipped }   401 unauthorized
export interface PendingRow {
  id: string;
  org_id: string;
  provider: string;
  provider_message_id: string;
}
export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}
export interface ReconcileDeps {
  /** api.pending_price_reconciliation */
  pending(limit: number): Promise<PendingRow[]>;
  /** api.get_channel_config for the org's sms channel; null when it has no usable Twilio account. */
  credentials(orgId: string): Promise<TwilioCredentials | null>;
  /** GET the Message resource; price is a string such as "-0.00790", or null while Twilio is still settling. */
  fetchMessage(creds: TwilioCredentials, sid: string): Promise<{ price: string | null; price_unit: string | null }>;
  /** api.apply_provider_price; a null price only records the check. */
  apply(orgId: string, id: string, price: number | null, currency: string | null): Promise<void>;
  secret: string;
  log(line: string): void;
}

export const LIMIT = 100;

export async function reconcile(deps: ReconcileDeps): Promise<{ checked: number; priced: number; skipped: number }> {
  const rows = await deps.pending(LIMIT);
  const creds = new Map<string, Promise<TwilioCredentials | null>>();
  let priced = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      if (row.provider !== 'twilio') { skipped++; continue; }
      if (!creds.has(row.org_id)) creds.set(row.org_id, deps.credentials(row.org_id).catch(() => null));
      const c = await creds.get(row.org_id);
      // No account to ask: leave the row alone so it is retried once the org has one.
      if (!c) { skipped++; continue; }
      const msg = await deps.fetchMessage(c, row.provider_message_id);
      const price = msg.price === null || msg.price === '' ? null : Number(msg.price);
      const ok = price !== null && Number.isFinite(price);
      await deps.apply(row.org_id, row.id, ok ? price : null, ok ? msg.price_unit : null);
      if (ok) priced++;
    } catch (err) {
      skipped++;
      deps.log(`reconcile ${row.id} failed: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
  return { checked: rows.length, priced, skipped };
}

function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function createReconcileHandler(deps: ReconcileDeps): (req: Request) => Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    if (deps.secret.length < 32 || !sameKey(req.headers.get('Authorization') ?? '', `Bearer ${deps.secret}`)) {
      return json(401, { error: 'unauthorized' });
    }
    return json(200, await reconcile(deps));
  };
}

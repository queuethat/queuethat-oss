// reconcile-costs entry point. The logic and its contract are in handler.ts.
// An Edge Function because it calls Twilio with the org's own credentials (technical-design.md 3.5, rule 3).
import { createClient } from '@supabase/supabase-js';
import { logInfo } from '../_shared/log.ts';
import { createReconcileHandler, type PendingRow } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const api = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('api');
const twilioBase = Deno.env.get('TWILIO_API_BASE') ?? 'https://api.twilio.com';

Deno.serve(createReconcileHandler({
  async pending(limit) {
    const { data, error } = await api.rpc('pending_price_reconciliation', { p_limit: limit });
    if (error) throw new Error(error.message);
    return (data ?? []) as PendingRow[];
  },
  async credentials(orgId) {
    const { data, error } = await api.rpc('get_channel_config', { p_org_id: orgId, p_channel: 'sms' });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    const sid = row?.config?.account_sid;
    const token = row?.secrets?.auth_token;
    return row?.provider === 'twilio' && row.enabled && typeof sid === 'string' && typeof token === 'string'
      ? { accountSid: sid, authToken: token }
      : null;
  },
  async fetchMessage(c, sid) {
    const res = await fetch(`${twilioBase}/2010-04-01/Accounts/${c.accountSid}/Messages/${encodeURIComponent(sid)}.json`, {
      headers: { Authorization: `Basic ${btoa(`${c.accountSid}:${c.authToken}`)}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`twilio_${res.status}`);
    return await res.json();
  },
  async apply(orgId, id, price, currency) {
    const { error } = await api.rpc('apply_provider_price', {
      p_org_id: orgId, p_notification_id: id, p_price: price, p_currency: currency,
    });
    if (error) throw new Error(error.message);
  },
  secret: env('DISPATCH_SECRET'),
  log: (line) => logInfo(line),
}));

// 2B-I7 (#312): deliver-webhooks entry point. The logic and its contract are in handler.ts.
// An Edge Function because sending needs secrets and outbound I/O (technical-design.md 3.5, rule 3).
import { createClient } from '@supabase/supabase-js';
import { logInfo } from '../_shared/log.ts';
import { createDeliverHandler, type WebhookJob } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const api = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('api');

Deno.serve(createDeliverHandler({
  async claim(limit, leaseSeconds) {
    const { data, error } = await api.rpc('claim_webhook_deliveries', {
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as WebhookJob[];
  },
  async report(deliveryId, result) {
    const { error } = await api.rpc('report_webhook_result', {
      p_delivery_id: deliveryId,
      p_result: result,
    });
    if (error) throw new Error(error.message);
  },
  async resolve(host) {
    if (/^[\d.]+$/.test(host) || host.includes(':')) return [host];
    const [a, aaaa] = await Promise.allSettled([
      Deno.resolveDns(host, 'A'),
      Deno.resolveDns(host, 'AAAA'),
    ]);
    return [
      ...(a.status === 'fulfilled' ? a.value : []),
      ...(aaaa.status === 'fulfilled' ? aaaa.value : []),
    ];
  },
  async post(url, headers, body, timeoutMs) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read at most 64 KB of the answer, then drop the rest; nothing of it is kept.
    const reader = res.body?.getReader();
    let seen = 0;
    while (reader && seen < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.length;
    }
    await reader?.cancel();
    return { status: res.status };
  },
  secret: env('DISPATCH_SECRET'),
  allowPrivate: Deno.env.get('WEBHOOK_ALLOW_PRIVATE') === 'true',
  now: () => Math.floor(Date.now() / 1000),
  log: (line) => logInfo(line),
}));

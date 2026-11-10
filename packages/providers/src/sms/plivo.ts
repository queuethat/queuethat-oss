// Plivo SMS channel (N-5, 3-SMS5). Message API with an auth id and token; fetch only. Delivery
// reports and inbound texts arrive through provider-webhook (handlers/plivo.ts).
import { defineChannel, failed, type NotificationChannel } from '../channel.ts';
import { isSecureUrl } from './url.ts';

export interface PlivoOptions {
  authId: string;
  /** Secret. Never logged: transport errors are scrubbed of it. */
  authToken: string;
  /** Sender number or id the org registered with Plivo. */
  from: string;
  /** Where Plivo posts delivery reports; omitted when the org has no endpoint yet. */
  statusUrl?: string;
  /** Billable segments of a body (packages/domain `smsSegments`); injected to keep this package import-free. */
  segments(text: string): { segments: number };
  /** Price of one segment in micros, when known. Left out, the database estimates from `provider_rates`. */
  ratePerSegmentMicros?(to: string): number;
  apiBase?: string;
  fetch?: typeof fetch;
}

export function plivoChannel(opts: PlivoOptions): NotificationChannel {
  const { authId, authToken, from, fetch: doFetch = fetch } = opts;
  const apiBase = opts.apiBase ?? 'https://api.plivo.com';
  if (!/^[A-Za-z0-9]{1,40}$/.test(authId)) throw new Error('plivo: invalid authId');
  if (!authToken) throw new Error('plivo: authToken is required');
  if (!from) throw new Error('plivo: from is required');
  if (!isSecureUrl(apiBase)) throw new Error('plivo: apiBase must be https');
  if (opts.statusUrl && !isSecureUrl(opts.statusUrl))
    throw new Error('plivo: statusUrl must be https');
  const rate = opts.ratePerSegmentMicros;
  const scrub = (s: string) => s.replaceAll(authToken, '***');
  const bodyOf = (m: { text: string; url?: string }) => (m.url ? `${m.text}\n${m.url}` : m.text);

  return defineChannel({
    kind: 'sms',
    providerName: 'plivo',
    estimate(msg) {
      const { segments } = opts.segments(bodyOf(msg));
      const to = msg.to.kind === 'address' ? msg.to.value : '';
      return { segments, ...(rate && { costMicros: segments * rate(to) }) };
    },
    async deliver(msg) {
      if (msg.to.kind !== 'address')
        return failed(false, 'unsupported_recipient', 'plivo needs a phone number');
      const text = bodyOf(msg);
      const { segments } = opts.segments(text);
      let res: Response;
      try {
        res = await doFetch(`${apiBase}/v1/Account/${authId}/Message/`, {
          method: 'POST',
          signal: AbortSignal.timeout(20_000),
          headers: {
            Authorization: `Basic ${btoa(`${authId}:${authToken}`)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            src: from,
            dst: msg.to.value.replace(/^\+/, ''),
            text,
            ...(opts.statusUrl && { url: opts.statusUrl, method: 'POST' }),
          }),
        });
      } catch (err) {
        return failed(true, 'network_error', scrub(String(err)));
      }
      const data = (await res.json().catch(() => ({}))) as {
        message_uuid?: string[];
        error?: string;
      };
      const uuid = data.message_uuid?.[0];
      if (res.ok && uuid) {
        return {
          status: 'sent',
          providerMessageId: uuid,
          segments,
          ...(rate && { costMicros: segments * rate(msg.to.value) }),
        };
      }
      const message = scrub((data.error ?? '').slice(0, 200));
      if (res.status === 400) return failed(false, 'invalid_request', message);
      if (res.status === 429) return failed(true, 'rate_limited', message);
      return failed(res.status >= 500, `http_${res.status}`, message);
    },
  });
}

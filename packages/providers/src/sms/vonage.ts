// Vonage SMS channel (N-5, 3-SMS4). Messages API with an API key and secret; fetch only. Delivery
// reports and inbound texts arrive through provider-webhook (handlers/vonage.ts).
import { defineChannel, failed, type NotificationChannel } from '../channel.ts';
import { isSecureUrl } from './url.ts';

export interface VonageOptions {
  apiKey: string;
  /** Secret. Never logged: transport errors are scrubbed of it. */
  apiSecret: string;
  /** Sender id or number the org registered with Vonage. */
  from: string;
  /** Where Vonage posts delivery reports; omitted when the org has no endpoint yet. */
  statusUrl?: string;
  /** Billable segments of a body (packages/domain `smsSegments`); injected to keep this package import-free. */
  segments(text: string): { segments: number };
  /** Price of one segment in micros, when known. Left out, the database estimates from `provider_rates`. */
  ratePerSegmentMicros?(to: string): number;
  apiBase?: string;
  fetch?: typeof fetch;
}

export function vonageChannel(opts: VonageOptions): NotificationChannel {
  const { apiKey, apiSecret, from, fetch: doFetch = fetch } = opts;
  const apiBase = opts.apiBase ?? 'https://api.nexmo.com';
  if (!apiKey || !apiSecret) throw new Error('vonage: apiKey and apiSecret are required');
  if (!from) throw new Error('vonage: from is required');
  if (!isSecureUrl(apiBase)) throw new Error('vonage: apiBase must be https');
  if (opts.statusUrl && !isSecureUrl(opts.statusUrl))
    throw new Error('vonage: statusUrl must be https');
  const rate = opts.ratePerSegmentMicros;
  const scrub = (s: string) => s.replaceAll(apiSecret, '***');
  const bodyOf = (m: { text: string; url?: string }) => (m.url ? `${m.text}\n${m.url}` : m.text);

  return defineChannel({
    kind: 'sms',
    providerName: 'vonage',
    estimate(msg) {
      const { segments } = opts.segments(bodyOf(msg));
      const to = msg.to.kind === 'address' ? msg.to.value : '';
      return { segments, ...(rate && { costMicros: segments * rate(to) }) };
    },
    async deliver(msg) {
      if (msg.to.kind !== 'address')
        return failed(false, 'unsupported_recipient', 'vonage needs a phone number');
      const text = bodyOf(msg);
      const { segments } = opts.segments(text);
      let res: Response;
      try {
        res = await doFetch(`${apiBase}/v1/messages`, {
          method: 'POST',
          signal: AbortSignal.timeout(20_000),
          headers: {
            Authorization: `Basic ${btoa(`${apiKey}:${apiSecret}`)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message_type: 'text',
            channel: 'sms',
            // Vonage wants the number without the leading plus.
            to: msg.to.value.replace(/^\+/, ''),
            from,
            text,
            ...(opts.statusUrl && { webhook_url: opts.statusUrl }),
          }),
        });
      } catch (err) {
        return failed(true, 'network_error', scrub(String(err)));
      }
      const data = (await res.json().catch(() => ({}))) as {
        message_uuid?: string;
        title?: string;
      };
      if (res.ok && data.message_uuid) {
        return {
          status: 'sent',
          providerMessageId: data.message_uuid,
          segments,
          ...(rate && { costMicros: segments * rate(msg.to.value) }),
        };
      }
      const message = scrub((data.title ?? '').slice(0, 200));
      if (res.status === 422) return failed(false, 'invalid_request', message);
      if (res.status === 429) return failed(true, 'rate_limited', message);
      return failed(res.status >= 500, `http_${res.status}`, message);
    },
  });
}

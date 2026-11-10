// Telnyx SMS channel (N-5, 3-SMS3). Messages API v2 with a messaging profile; fetch only. Delivery
// reports and inbound texts arrive through provider-webhook (handlers/telnyx.ts).
import { defineChannel, failed, type NotificationChannel } from '../channel.ts';
import { isSecureUrl } from './url.ts';

export interface TelnyxOptions {
  /** Secret. Never logged: transport errors are scrubbed of it. */
  apiKey: string;
  messagingProfileId: string;
  /** `{PUBLIC_FUNCTIONS_URL}/provider-webhook/telnyx/{endpoint_id}`; omitted when the org has no endpoint yet. */
  webhookUrl?: string;
  /** Billable segments of a body (packages/domain `smsSegments`); injected to keep this package import-free. */
  segments(text: string): { segments: number };
  /** Price of one segment in micros, when known. Left out, the database estimates from `provider_rates`. */
  ratePerSegmentMicros?(to: string): number;
  apiBase?: string;
  fetch?: typeof fetch;
}

// https://developers.telnyx.com/docs/messaging/messages/error-codes
const BLOCKED_BY_STOP = '40300';
const INVALID_NUMBER = new Set(['40310', '40008']);

export function telnyxChannel(opts: TelnyxOptions): NotificationChannel {
  const { apiKey, messagingProfileId, fetch: doFetch = fetch } = opts;
  const apiBase = opts.apiBase ?? 'https://api.telnyx.com';
  if (!apiKey) throw new Error('telnyx: apiKey is required');
  if (!messagingProfileId) throw new Error('telnyx: messagingProfileId is required');
  if (!isSecureUrl(apiBase)) throw new Error('telnyx: apiBase must be https');
  if (opts.webhookUrl && !isSecureUrl(opts.webhookUrl))
    throw new Error('telnyx: webhookUrl must be https');
  const rate = opts.ratePerSegmentMicros;
  const bodyOf = (m: { text: string; url?: string }) => (m.url ? `${m.text}\n${m.url}` : m.text);

  return defineChannel({
    kind: 'sms',
    providerName: 'telnyx',
    estimate(msg) {
      const { segments } = opts.segments(bodyOf(msg));
      const to = msg.to.kind === 'address' ? msg.to.value : '';
      return { segments, ...(rate && { costMicros: segments * rate(to) }) };
    },
    async deliver(msg) {
      if (msg.to.kind !== 'address')
        return failed(false, 'unsupported_recipient', 'telnyx needs a phone number');
      const text = bodyOf(msg);
      const { segments } = opts.segments(text);
      let res: Response;
      try {
        res = await doFetch(`${apiBase}/v2/messages`, {
          method: 'POST',
          signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_profile_id: messagingProfileId,
            to: msg.to.value,
            text,
            ...(opts.webhookUrl && { webhook_url: opts.webhookUrl }),
          }),
        });
      } catch (err) {
        return failed(true, 'network_error', String(err).replaceAll(apiKey, '***'));
      }
      const data = (await res.json().catch(() => ({}))) as {
        data?: { id?: string; parts?: number };
        errors?: Array<{ code?: string; title?: string }>;
      };
      if (res.ok && data.data?.id) {
        return {
          status: 'sent',
          providerMessageId: data.data.id,
          segments: data.data.parts ?? segments,
          ...(rate && { costMicros: segments * rate(msg.to.value) }),
        };
      }
      const err = data.errors?.[0];
      const message = (err?.title ?? '').replaceAll(apiKey, '***').slice(0, 200);
      // The recipient opted out of this sender: `gone` suppresses the number for this org only.
      if (err?.code === BLOCKED_BY_STOP) return { status: 'gone', code: 'unsubscribed', message };
      if (err?.code && INVALID_NUMBER.has(err.code))
        return failed(false, 'invalid_number', message);
      if (res.status === 429) return failed(true, 'rate_limited', message);
      return failed(res.status >= 500, `http_${res.status}`, message);
    },
  });
}

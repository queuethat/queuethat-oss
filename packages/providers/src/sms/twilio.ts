// Twilio SMS channel (N-5, 3-SMS1). Sends through a Messaging Service SID, which carries the
// org's 10DLC registration and Twilio's Advanced Opt-Out. Fetch only, so it runs in Deno and in
// the browser. Status callbacks and inbound replies belong to 3-SMS2 and the webhook core.
import { defineChannel, failed, type NotificationChannel } from '../channel.ts';
import { isSecureUrl } from './url.ts';

export interface TwilioOptions {
  accountSid: string;
  /** Secret. Never logged: transport errors are scrubbed of it. */
  authToken: string;
  /**
   * A restricted API Key SID (`SK...`). When set, requests authenticate as `apiKeySid:authToken`
   * (authToken is then the key's secret) while the account SID still names the account in the URL.
   * The platform sender uses this so the account's main auth token never reaches the function.
   */
  apiKeySid?: string;
  messagingServiceSid: string;
  /**
   * Where Twilio posts delivery reports: `{PUBLIC_FUNCTIONS_URL}/provider-webhook/twilio/{endpoint_id}`.
   * Omitted when the org has no webhook endpoint yet.
   */
  statusCallbackUrl?: string;
  /** Billable segments of a body (packages/domain `smsSegments`); injected to keep this package import-free. */
  segments(text: string): { segments: number };
  /**
   * Price of one segment in micros, when the caller knows it. Left out, the send carries no cost
   * and `api.report_outbox_result` estimates it from `provider_rates`.
   */
  ratePerSegmentMicros?(to: string): number;
  /** Twilio origin; tests and local fakes override it. */
  apiBase?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Twilio error codes with a meaning for the dispatcher. https://www.twilio.com/docs/api/errors */
const UNSUBSCRIBED = 21610;
const INVALID_NUMBER = new Set([21211, 21214, 21614]);
const CARRIER_FILTERED = 30007;

/**
 * Body sent to Twilio: the message plus the status link when there is one. The segment count
 * covers the same text, so the estimate matches what Twilio bills.
 */
function bodyOf(msg: { text: string; url?: string }): string {
  return msg.url ? `${msg.text}\n${msg.url}` : msg.text;
}

export function twilioChannel(opts: TwilioOptions): NotificationChannel {
  const { accountSid, authToken, messagingServiceSid, fetch: doFetch = fetch } = opts;
  const apiBase = opts.apiBase ?? 'https://api.twilio.com';
  // Config comes from the operator or the org, so refuse a malformed one up front.
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) throw new Error('twilio: invalid accountSid');
  if (!authToken) throw new Error('twilio: authToken is required');
  if (opts.apiKeySid !== undefined && !/^SK[0-9a-f]{32}$/i.test(opts.apiKeySid)) {
    throw new Error('twilio: invalid apiKeySid');
  }
  const basicUser = opts.apiKeySid ?? accountSid;
  if (!isSecureUrl(apiBase)) throw new Error('twilio: apiBase must be https');
  if (opts.statusCallbackUrl && !isSecureUrl(opts.statusCallbackUrl)) {
    throw new Error('twilio: statusCallbackUrl must be https');
  }
  const rate = opts.ratePerSegmentMicros;
  const scrub = (s: string) => s.replaceAll(authToken, '***');

  return defineChannel({
    kind: 'sms',
    providerName: 'twilio',
    estimate(msg) {
      const { segments } = opts.segments(bodyOf(msg));
      const to = msg.to.kind === 'address' ? msg.to.value : '';
      return { segments, ...(rate && { costMicros: segments * rate(to) }) };
    },
    async deliver(msg) {
      if (msg.to.kind !== 'address') {
        return failed(false, 'unsupported_recipient', 'twilio needs a phone number');
      }
      const body = bodyOf(msg);
      const { segments } = opts.segments(body);
      const form = new URLSearchParams({
        MessagingServiceSid: messagingServiceSid,
        To: msg.to.value,
        Body: body,
      });
      if (opts.statusCallbackUrl) form.set('StatusCallback', opts.statusCallbackUrl);
      let res: Response;
      try {
        res = await doFetch(`${apiBase}/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: 'POST',
          signal: AbortSignal.timeout(20_000),
          headers: {
            Authorization: `Basic ${btoa(`${basicUser}:${authToken}`)}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            // A retry after a lost response must not text the guest twice.
            'I-Twilio-Idempotency-Token': msg.outboxId,
          },
          body: form,
        });
      } catch (err) {
        return failed(true, 'network_error', scrub(String(err)));
      }
      const data = (await res.json().catch(() => ({}))) as {
        sid?: string;
        code?: number;
        message?: string;
      };
      if (res.ok && data.sid) {
        return {
          status: 'sent',
          providerMessageId: data.sid,
          segments,
          ...(rate && { costMicros: segments * rate(msg.to.value) }),
        };
      }
      const message = scrub((data.message ?? '').slice(0, 200));
      // The recipient opted out at Twilio. Reported as `gone`, which suppresses the number for
      // this org (api.report_outbox_result) so no later message tries it.
      if (data.code === UNSUBSCRIBED) return { status: 'gone', code: 'unsubscribed', message };
      if (data.code !== undefined && INVALID_NUMBER.has(data.code)) {
        return failed(false, 'invalid_number', message);
      }
      if (data.code === CARRIER_FILTERED) return failed(false, 'carrier_filtered', message);
      if (res.status === 429) return failed(true, 'rate_limited', message);
      return failed(res.status >= 500, `http_${res.status}`, message);
    },
  });
}

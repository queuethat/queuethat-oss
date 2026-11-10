// Pieces the HTTP email adapters share: the plain-text body, header mapping and the rule for
// which provider answers are worth retrying.
import { failed, type OutboundMessage, type SendResult } from '../channel.ts';

export interface HttpEmailOptions {
  /** Provider API key / server token. Never logged and never part of a failure message. */
  apiKey: string;
  /** CAN-SPAM: must be the org's real sending identity (from org settings). */
  from: { email: string; name?: string };
  replyTo?: string;
  /** Override for sandboxes and tests. */
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** "Name <a@b>" with the name quoted, or the bare address. */
export function formatAddress({ email, name }: { email: string; name?: string }): string {
  return name ? `"${name.replace(/["\\\r\n]/g, '')}" <${email}>` : email;
}

export function textBody(msg: OutboundMessage): string {
  return msg.url ? `${msg.text}\n\n${msg.url}` : msg.text;
}

/** One plain address: no list separators, display-name syntax, whitespace or control characters. */
export function isSingleAddress(value: string): boolean {
  return /^[^\s,;<>"()\\\p{Cc}]+@[^\s,;<>"()\\\p{Cc}@]+$/u.test(value);
}

function isSafeUnsubscribeUrl(url: string | undefined): url is string {
  if (!url || /[\s<>,"\p{Cc}]/u.test(url)) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Extra headers; List-Unsubscribe only for https, as the database-issued URL is. */
export function mailHeaders(msg: OutboundMessage): Record<string, string> {
  return {
    'X-Outbox-Id': msg.outboxId,
    ...(isSafeUnsubscribeUrl(msg.unsubscribeUrl)
      ? {
          'List-Unsubscribe': `<${msg.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : {}),
  };
}

export type ProviderCall =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; result: Extract<SendResult, { status: 'failed' }> };

/**
 * POSTs JSON and sorts the answer: 2xx is accepted (even with an unparseable body, so a parse
 * error can't cause a resend); 429, 409 and 5xx retry; 401/403 never retry (the key is wrong);
 * 422 means the provider rejected an address, `invalid_recipient`; other 4xx are our fault.
 */
export async function postJson(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  isInvalidRecipient: (json: Record<string, unknown>) => boolean,
): Promise<ProviderCall> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      // Well inside the dispatcher's 60 s lease, so a hung send can't overlap a reclaim.
      signal: AbortSignal.timeout(20_000),
      // A redirect would forward the provider credential header to wherever it points.
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, result: failed(true, 'network_error', String(err)) };
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, json };
  // Provider messages describe our request, not our credentials, but cap them anyway.
  const message = String(json.Message ?? json.message ?? res.statusText).slice(0, 200);
  const code =
    res.status === 422 && isInvalidRecipient(json) ? 'invalid_recipient' : `http_${res.status}`;
  const retryable = res.status === 429 || res.status === 409 || res.status >= 500;
  return { ok: false, result: failed(retryable, code, message) };
}

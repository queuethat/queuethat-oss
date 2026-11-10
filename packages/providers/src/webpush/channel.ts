// Web push (N4, #70). The channel decides what to send and what a push service's answer means;
// encryption and VAPID signing (RFC 8291/8292) sit behind PushTransport, which the Edge Function
// implements with jsr:@negrel/webpush (K2, #29), so this package stays dependency-free.
import { defineChannel, failed, type NotificationChannel } from '../channel.ts';

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  ttlSeconds: number;
  urgency: 'normal' | 'high';
  /** A newer message with the same topic replaces one the push service still holds. */
  topic: string;
}

/**
 * Encrypts `payload` for `subscription`, signs it with the VAPID key and POSTs it without
 * following redirects. Resolves to the push service's HTTP answer, or to status 0 when the
 * subscription can't be sent to at all (malformed keys); rejects only when no answer came.
 */
export type PushTransport = (
  subscription: PushSubscriptionKeys,
  payload: string,
  options: PushOptions,
) => Promise<{ status: number; body?: string }>;

/** What the service worker receives; it must show a notification for every push. */
export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag: 'visit';
}

/** Largest plaintext that fits one aes128gcm record in the 4096-byte push message limit. */
export const MAX_PUSH_PAYLOAD_BYTES = 3993;

/** Ten minutes: a "called" push that arrives later than that only confuses. */
export const PUSH_TTL_SECONDS = 600;

const PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);

/**
 * True for an https URL on a known browser push service. The database refuses other endpoints
 * at registration (private.is_push_endpoint); this re-checks right before a send, so a row that
 * got in some other way still can't point the dispatcher at an arbitrary host.
 */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  return PUSH_HOSTS.has(url.hostname) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
}

export interface VapidWebPushOptions {
  transport: PushTransport;
}

/** Sends web push through `transport`. Free per message; a 404 or 410 means the subscription is gone. */
export function vapidWebPushChannel({ transport }: VapidWebPushOptions): NotificationChannel {
  return defineChannel({
    kind: 'push',
    providerName: 'vapid',
    async deliver(msg) {
      if (msg.to.kind !== 'push') {
        return failed(false, 'unsupported_recipient', 'push needs a push subscription recipient');
      }
      const payload: PushPayload = {
        title: msg.subject ?? '',
        body: msg.text,
        ...(msg.url ? { url: msg.url } : {}),
        tag: 'visit',
      };
      const json = JSON.stringify(payload);
      if (new TextEncoder().encode(json).byteLength > MAX_PUSH_PAYLOAD_BYTES) {
        return failed(
          false,
          'payload_too_large',
          `push payload over ${MAX_PUSH_PAYLOAD_BYTES} bytes`,
        );
      }
      const { endpoint, p256dh, auth } = msg.to;
      if (!isPushEndpoint(endpoint)) {
        return failed(false, 'endpoint_not_allowed', 'not a known push service');
      }
      let res: { status: number; body?: string };
      try {
        res = await transport({ endpoint, p256dh, auth }, json, {
          ttlSeconds: PUSH_TTL_SECONDS,
          urgency: msg.trigger === 'called' ? 'high' : 'normal',
          topic: 'visit',
        });
      } catch {
        // The error text can carry the endpoint URL, which identifies the guest's browser.
        return failed(true, 'network_error', 'push service unreachable');
      }
      const detail = (res.body ?? '').slice(0, 200);
      if (res.status === 0) return failed(false, 'invalid_subscription', detail);
      if (res.status >= 200 && res.status < 300) return { status: 'sent', costMicros: 0 };
      if (res.status === 404 || res.status === 410) {
        return { status: 'gone', code: `http_${res.status}`, message: detail };
      }
      // 429 and 5xx are worth retrying; any other answer (3xx, 400, 403 VAPID, 413) is not.
      return failed(res.status === 429 || res.status >= 500, `http_${res.status}`, detail);
    },
  });
}

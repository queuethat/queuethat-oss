import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '../channel.ts';
import { runChannelContract, zoneAtLocalHour } from '../contract.ts';
import {
  isPushEndpoint,
  MAX_PUSH_PAYLOAD_BYTES,
  type PushOptions,
  type PushPayload,
  type PushTransport,
  vapidWebPushChannel,
} from './channel.ts';

/** In-memory push service: records every push, or answers the next one with a forced result. */
function fakePushService() {
  const pushed: Array<{ endpoint: string; payload: PushPayload; options: PushOptions }> = [];
  let next: number | Error | null = null;
  const transport: PushTransport = async (subscription, payload, options) => {
    const forced = next;
    next = null;
    if (forced instanceof Error) throw forced;
    if (forced !== null) return { status: forced, body: `forced ${forced}` };
    pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
    return { status: 201 };
  };
  return { pushed, transport, answerNext: (r: number | Error) => (next = r) };
}

function harness() {
  const service = fakePushService();
  return {
    service,
    channel: vapidWebPushChannel({ transport: service.transport }),
    to: {
      kind: 'push' as const,
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: 'B' + 'x'.repeat(86),
      auth: 'a'.repeat(22),
    },
    delivered: async () => service.pushed.map((p) => ({ text: p.payload.body })),
    breakNext: () => service.answerNext(new Error('ECONNRESET')),
  };
}

runChannelContract('vapid web push (fake push service)', harness);

describe('vapidWebPushChannel', () => {
  const message = (h: ReturnType<typeof harness>, o: Partial<OutboundMessage> = {}) => ({
    outboxId: 'n-1',
    orgId: 'org-1',
    channel: 'push' as const,
    category: 'transactional' as const,
    trigger: 'called' as const,
    to: h.to,
    subject: "It's your turn",
    text: 'Please go to Chair 2. (A012)',
    url: 'https://queue.example/v/t',
    policy: { hasConsent: true, isSuppressed: false, locationTz: zoneAtLocalHour(12) },
    ...o,
  });

  it('sends a notification payload with a short TTL, one topic per visit and urgency by trigger', async () => {
    const h = harness();
    expect(await h.channel.send(message(h))).toEqual({ status: 'sent', costMicros: 0 });
    await h.channel.send(message(h, { trigger: 'almost_up' }));
    expect(h.service.pushed.map((p) => p.payload)[0]).toEqual({
      title: "It's your turn",
      body: 'Please go to Chair 2. (A012)',
      url: 'https://queue.example/v/t',
      tag: 'visit',
    });
    expect(h.service.pushed.map((p) => p.options)).toEqual([
      { ttlSeconds: 600, urgency: 'high', topic: 'visit' },
      { ttlSeconds: 600, urgency: 'normal', topic: 'visit' },
    ]);
  });

  it.each([404, 410])(
    'AC1: reports %i as gone, so the outbox deletes the subscription',
    async (code) => {
      const h = harness();
      h.service.answerNext(code);
      expect(await h.channel.send(message(h))).toEqual({
        status: 'gone',
        code: `http_${code}`,
        message: `forced ${code}`,
      });
    },
  );

  it.each([
    [429, true],
    [503, true],
    [400, false],
    [403, false],
    [413, false],
  ])('maps HTTP %i to a failure with retryable %s', async (code, retryable) => {
    const h = harness();
    h.service.answerNext(code);
    expect(await h.channel.send(message(h))).toMatchObject({
      status: 'failed',
      retryable,
      code: `http_${code}`,
    });
  });

  it('refuses a payload over the push size limit without sending', async () => {
    const h = harness();
    const text = 'x'.repeat(MAX_PUSH_PAYLOAD_BYTES);
    expect(await h.channel.send(message(h, { text }))).toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'payload_too_large',
    });
    expect(h.service.pushed).toEqual([]);
  });

  it.each([
    'https://evil.example/fcm.googleapis.com/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user@fcm.googleapis.com/x',
    'http://fcm.googleapis.com/x',
    'https://a.b.notify.windows.com/x',
  ])('refuses %s without sending: not a known push service', async (endpoint) => {
    const h = harness();
    expect(await h.channel.send(message(h, { to: { ...h.to, endpoint } }))).toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'endpoint_not_allowed',
    });
    expect(h.service.pushed).toEqual([]);
  });

  it('accepts the WNS and Apple endpoints browsers hand out', () => {
    expect(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/QH3k')).toBe(true);
  });

  it('keeps the endpoint out of a network failure and calls malformed keys final', async () => {
    const h = harness();
    h.service.answerNext(new Error(`fetch failed: ${h.to.endpoint}`));
    const down = await h.channel.send(message(h));
    expect(down).toMatchObject({ status: 'failed', retryable: true, code: 'network_error' });
    expect(JSON.stringify(down)).not.toContain('fcm.googleapis.com');
    h.service.answerNext(0);
    expect(await h.channel.send(message(h))).toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'invalid_subscription',
    });
  });

  it('refuses an address recipient', async () => {
    const h = harness();
    const to = { kind: 'address' as const, value: 'guest@example.test' };
    expect(await h.channel.send(message(h, { to }))).toMatchObject({
      status: 'failed',
      code: 'unsupported_recipient',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { smsSegments } from '../../../domain/src/sms-segments.ts';
import type { OutboundMessage } from '../channel.ts';
import { runChannelContract, zoneAtLocalHour } from '../contract.ts';
import { telnyxChannel } from './telnyx.ts';
import e10009 from '../../../../tests/fixtures/providers/telnyx/error-10009.json';
import e10010 from '../../../../tests/fixtures/providers/telnyx/error-10010.json';
import e40300 from '../../../../tests/fixtures/providers/telnyx/error-40300.json';
import e40310 from '../../../../tests/fixtures/providers/telnyx/error-40310.json';
import queued from '../../../../tests/fixtures/providers/telnyx/message-queued.json';

/** Recorded Telnyx responses behind a fake Messages endpoint. */
function fakeTelnyx() {
  const posted: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, string>;
  }> = [];
  let next: { status: number; body: unknown } | Error | null = null;
  const doFetch = (async (url: string, init: RequestInit) => {
    const forced = next;
    next = null;
    if (forced instanceof Error) throw forced;
    posted.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    const r = forced ?? { status: 200, body: queued };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { posted, doFetch, answerNext: (r: NonNullable<typeof next>) => (next = r) };
}

const options = { apiKey: 'KEY-secret', messagingProfileId: 'prof-1', segments: smsSegments };

function harness() {
  const telnyx = fakeTelnyx();
  return {
    telnyx,
    channel: telnyxChannel({
      ...options,
      webhookUrl: 'https://fn.example/provider-webhook/telnyx/ep-1',
      ratePerSegmentMicros: () => 4000,
      fetch: telnyx.doFetch,
    }),
    to: { kind: 'address' as const, value: '+15558675310' },
    delivered: async () => telnyx.posted.map((p) => ({ text: p.body.text ?? '' })),
    breakNext: () => telnyx.answerNext(new Error('ECONNRESET KEY-secret')),
  };
}

runChannelContract('telnyx (recorded responses)', harness);

const msg = (h: ReturnType<typeof harness>, text: string): OutboundMessage => ({
  outboxId: 'n-1',
  orgId: 'org-1',
  channel: 'sms',
  category: 'transactional',
  trigger: 'called',
  to: h.to,
  text,
  policy: { hasConsent: true, isSuppressed: false, locationTz: zoneAtLocalHour(12) },
});

describe('telnyxChannel', () => {
  it('posts to the messaging profile with the webhook and a bearer key', async () => {
    const h = harness();
    expect(await h.channel.send(msg(h, 'Hi'))).toEqual({
      status: 'sent',
      providerMessageId: '40385f64-5717-4562-b3fc-2c963f66afa6',
      segments: 1,
      costMicros: 4000,
    });
    const [req] = h.telnyx.posted;
    expect(req?.url).toBe('https://api.telnyx.com/v2/messages');
    expect(req?.headers.Authorization).toBe('Bearer KEY-secret');
    expect(req?.body).toMatchObject({
      messaging_profile_id: 'prof-1',
      to: '+15558675310',
      webhook_url: 'https://fn.example/provider-webhook/telnyx/ep-1',
    });
  });

  it('estimates segments and cost', () => {
    const h = harness();
    expect(h.channel.estimate(msg(h, 'a'.repeat(161)))).toEqual({ segments: 2, costMicros: 8000 });
  });

  it.each([
    [40300, e40300, 'gone', { code: 'unsubscribed' }],
    [400, e40310, 'failed', { retryable: false, code: 'invalid_number' }],
    [401, e10009, 'failed', { retryable: false, code: 'http_401' }],
    [429, e10010, 'failed', { retryable: true, code: 'rate_limited' }],
    [503, {}, 'failed', { retryable: true, code: 'http_503' }],
  ])('maps response %s', async (status, body, expected, extra) => {
    const h = harness();
    h.telnyx.answerNext({ status: status === 40300 ? 403 : status, body });
    expect(await h.channel.send(msg(h, 'Hi'))).toMatchObject({ status: expected, ...extra });
  });

  it('keeps the api key out of transport errors', async () => {
    const h = harness();
    h.telnyx.answerNext(new Error('ECONNRESET KEY-secret'));
    expect(JSON.stringify(await h.channel.send(msg(h, 'Hi')))).not.toContain('KEY-secret');
  });

  it('sends no cost without a rate, so the database estimates it', async () => {
    const t = fakeTelnyx();
    const h = harness();
    const channel = telnyxChannel({ ...options, fetch: t.doFetch });
    expect(await channel.send(msg(h, 'Hi'))).toEqual({
      status: 'sent',
      providerMessageId: '40385f64-5717-4562-b3fc-2c963f66afa6',
      segments: 1,
    });
  });

  it.each([
    ['an empty key', { apiKey: '' }],
    ['a plain-http API base', { apiBase: 'http://evil.example' }],
    ['a plain-http webhook', { webhookUrl: 'http://fn.example/x' }],
  ])('rejects %s', (_name, bad) => {
    expect(() => telnyxChannel({ ...options, ...bad })).toThrow();
  });
});

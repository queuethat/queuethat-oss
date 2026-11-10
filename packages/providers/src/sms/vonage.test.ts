import { describe, expect, it } from 'vitest';
import { smsSegments } from '../../../domain/src/sms-segments.ts';
import type { OutboundMessage } from '../channel.ts';
import { runChannelContract, zoneAtLocalHour } from '../contract.ts';
import { vonageChannel } from './vonage.ts';
import e401 from '../../../../tests/fixtures/providers/vonage/error-401.json';
import e422 from '../../../../tests/fixtures/providers/vonage/error-422.json';
import e429 from '../../../../tests/fixtures/providers/vonage/error-429.json';
import accepted from '../../../../tests/fixtures/providers/vonage/message-accepted.json';

/** Recorded Vonage responses behind a fake Messages endpoint. */
function fakeVonage() {
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
    const r = forced ?? { status: 202, body: accepted };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { posted, doFetch, answerNext: (r: NonNullable<typeof next>) => (next = r) };
}

const options = {
  apiKey: 'key1',
  apiSecret: 'api-secret-9',
  from: 'QueueThat',
  segments: smsSegments,
};

function harness() {
  const vonage = fakeVonage();
  return {
    vonage,
    channel: vonageChannel({
      ...options,
      statusUrl: 'https://fn.example/provider-webhook/vonage/ep-1',
      ratePerSegmentMicros: () => 6000,
      fetch: vonage.doFetch,
    }),
    to: { kind: 'address' as const, value: '+15558675310' },
    delivered: async () => vonage.posted.map((p) => ({ text: p.body.text ?? '' })),
    breakNext: () => vonage.answerNext(new Error('ECONNRESET api-secret-9')),
  };
}

runChannelContract('vonage (recorded responses)', harness);

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

describe('vonageChannel', () => {
  it('posts a text message without the plus, with basic auth and the status url', async () => {
    const h = harness();
    expect(await h.channel.send(msg(h, 'Hi'))).toEqual({
      status: 'sent',
      providerMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      segments: 1,
      costMicros: 6000,
    });
    const [req] = h.vonage.posted;
    expect(req?.url).toBe('https://api.nexmo.com/v1/messages');
    expect(req?.headers.Authorization).toBe(`Basic ${btoa('key1:api-secret-9')}`);
    expect(req?.body).toMatchObject({
      channel: 'sms',
      to: '15558675310',
      from: 'QueueThat',
      webhook_url: 'https://fn.example/provider-webhook/vonage/ep-1',
    });
  });

  it('estimates segments and cost', () => {
    const h = harness();
    expect(h.channel.estimate(msg(h, 'a'.repeat(161)))).toEqual({ segments: 2, costMicros: 12000 });
  });

  it.each([
    [422, e422, { retryable: false, code: 'invalid_request' }],
    [401, e401, { retryable: false, code: 'http_401' }],
    [429, e429, { retryable: true, code: 'rate_limited' }],
    [503, {}, { retryable: true, code: 'http_503' }],
  ])('maps response %s', async (status, body, extra) => {
    const h = harness();
    h.vonage.answerNext({ status, body });
    expect(await h.channel.send(msg(h, 'Hi'))).toMatchObject({ status: 'failed', ...extra });
  });

  it('keeps the api secret out of transport errors', async () => {
    const h = harness();
    h.vonage.answerNext(new Error('ECONNRESET api-secret-9'));
    expect(JSON.stringify(await h.channel.send(msg(h, 'Hi')))).not.toContain('api-secret-9');
  });

  it('sends no cost without a rate, so the database estimates it', async () => {
    const v = fakeVonage();
    const h = harness();
    const channel = vonageChannel({ ...options, fetch: v.doFetch });
    expect(await channel.send(msg(h, 'Hi'))).toEqual({
      status: 'sent',
      providerMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      segments: 1,
    });
  });

  it.each([
    ['an empty secret', { apiSecret: '' }],
    ['a missing sender', { from: '' }],
    ['a plain-http API base', { apiBase: 'http://evil.example' }],
    ['a plain-http status url', { statusUrl: 'http://fn.example/x' }],
  ])('rejects %s', (_name, bad) => {
    expect(() => vonageChannel({ ...options, ...bad })).toThrow();
  });
});

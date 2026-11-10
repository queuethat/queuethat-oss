import { describe, expect, it } from 'vitest';
import { smsSegments } from '../../../domain/src/sms-segments.ts';
import type { OutboundMessage } from '../channel.ts';
import { runChannelContract, zoneAtLocalHour } from '../contract.ts';
import { plivoChannel } from './plivo.ts';
import { isSecureUrl } from './url.ts';
import e401 from '../../../../tests/fixtures/providers/plivo/error-401.json';
import e400 from '../../../../tests/fixtures/providers/plivo/error-400.json';
import e429 from '../../../../tests/fixtures/providers/plivo/error-429.json';
import accepted from '../../../../tests/fixtures/providers/plivo/message-queued.json';

/** Recorded Plivo responses behind a fake Messages endpoint. */
function fakePlivo() {
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
  authId: 'MAXXXXXXXXXXXXXXXXXX',
  authToken: 'api-secret-9',
  from: '15550000000',
  segments: smsSegments,
};

function harness() {
  const plivo = fakePlivo();
  return {
    plivo,
    channel: plivoChannel({
      ...options,
      statusUrl: 'https://fn.example/provider-webhook/plivo/ep-1',
      ratePerSegmentMicros: () => 6000,
      fetch: plivo.doFetch,
    }),
    to: { kind: 'address' as const, value: '+15558675310' },
    delivered: async () => plivo.posted.map((p) => ({ text: p.body.text ?? '' })),
    breakNext: () => plivo.answerNext(new Error('ECONNRESET api-secret-9')),
  };
}

runChannelContract('plivo (recorded responses)', harness);

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

describe('plivoChannel', () => {
  it('posts a text message without the plus, with basic auth and the status url', async () => {
    const h = harness();
    expect(await h.channel.send(msg(h, 'Hi'))).toEqual({
      status: 'sent',
      providerMessageId: 'db3ce55a-7f1d-11e1-8ea7-1231380c0f0b',
      segments: 1,
      costMicros: 6000,
    });
    const [req] = h.plivo.posted;
    expect(req?.url).toBe('https://api.plivo.com/v1/Account/MAXXXXXXXXXXXXXXXXXX/Message/');
    expect(req?.headers.Authorization).toBe(`Basic ${btoa('MAXXXXXXXXXXXXXXXXXX:api-secret-9')}`);
    expect(req?.body).toMatchObject({
      src: '15550000000',
      dst: '15558675310',
      url: 'https://fn.example/provider-webhook/plivo/ep-1',
    });
  });

  it('estimates segments and cost', () => {
    const h = harness();
    expect(h.channel.estimate(msg(h, 'a'.repeat(161)))).toEqual({ segments: 2, costMicros: 12000 });
  });

  it.each([
    [400, e400, { retryable: false, code: 'invalid_request' }],
    [401, e401, { retryable: false, code: 'http_401' }],
    [429, e429, { retryable: true, code: 'rate_limited' }],
    [503, {}, { retryable: true, code: 'http_503' }],
  ])('maps response %s', async (status, body, extra) => {
    const h = harness();
    h.plivo.answerNext({ status, body });
    expect(await h.channel.send(msg(h, 'Hi'))).toMatchObject({ status: 'failed', ...extra });
  });

  it('keeps the api secret out of transport errors', async () => {
    const h = harness();
    h.plivo.answerNext(new Error('ECONNRESET api-secret-9'));
    expect(JSON.stringify(await h.channel.send(msg(h, 'Hi')))).not.toContain('api-secret-9');
  });

  it('sends no cost without a rate, so the database estimates it', async () => {
    const v = fakePlivo();
    const h = harness();
    const channel = plivoChannel({ ...options, fetch: v.doFetch });
    expect(await channel.send(msg(h, 'Hi'))).toEqual({
      status: 'sent',
      providerMessageId: 'db3ce55a-7f1d-11e1-8ea7-1231380c0f0b',
      segments: 1,
    });
  });

  it.each([
    ['an empty token', { authToken: '' }],
    ['a bad auth id', { authId: '../x' }],
    ['a missing sender', { from: '' }],
    ['a plain-http API base', { apiBase: 'http://evil.example' }],
    ['a plain-http status url', { statusUrl: 'http://fn.example/x' }],
  ])('rejects %s', (_name, bad) => {
    expect(() => plivoChannel({ ...options, ...bad })).toThrow();
  });
});

describe('isSecureUrl', () => {
  it('accepts https and local http, and refuses userinfo tricks', () => {
    expect(isSecureUrl('https://api.example.test')).toBe(true);
    expect(isSecureUrl('http://localhost:54321')).toBe(true);
    expect(isSecureUrl('http://127.0.0.1/x')).toBe(true);
    expect(isSecureUrl('http://localhost:80@evil.test/')).toBe(false);
    expect(isSecureUrl('http://evil.test')).toBe(false);
    expect(isSecureUrl('not a url')).toBe(false);
  });
});

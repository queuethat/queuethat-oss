import { describe, expect, it } from 'vitest';
import { smsSegments } from '../../../domain/src/sms-segments.ts';
import type { OutboundMessage } from '../channel.ts';
import { runChannelContract, zoneAtLocalHour } from '../contract.ts';
import { twilioChannel } from './twilio.ts';
import e20429 from '../../../../tests/fixtures/providers/twilio/error-20429.json';
import e21211 from '../../../../tests/fixtures/providers/twilio/error-21211.json';
import e21610 from '../../../../tests/fixtures/providers/twilio/error-21610.json';
import e21614 from '../../../../tests/fixtures/providers/twilio/error-21614.json';
import e30007 from '../../../../tests/fixtures/providers/twilio/error-30007.json';
import queued from '../../../../tests/fixtures/providers/twilio/message-queued.json';

const byName: Record<string, unknown> = {
  'message-queued': queued,
  'error-20429': e20429,
  'error-21211': e21211,
  'error-21610': e21610,
  'error-21614': e21614,
  'error-30007': e30007,
};
const fixture = (name: string) => JSON.stringify(byName[name]);

/** Recorded Twilio responses behind a fake Messages endpoint. */
function fakeTwilio() {
  const posted: Array<{ url: string; headers: Record<string, string>; form: URLSearchParams }> = [];
  let next: { status: number; body: string } | Error | null = null;
  const doFetch = (async (url: string, init: RequestInit) => {
    const forced = next;
    next = null;
    if (forced instanceof Error) throw forced;
    posted.push({
      url,
      headers: init.headers as Record<string, string>,
      form: new URLSearchParams(String(init.body)),
    });
    const r = forced ?? { status: 201, body: fixture('message-queued') };
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  return { posted, doFetch, answerNext: (r: NonNullable<typeof next>) => (next = r) };
}

function harness() {
  const twilio = fakeTwilio();
  const channel = twilioChannel({
    accountSid: `AC${'0'.repeat(32)}`,
    authToken: 'super-secret-token',
    messagingServiceSid: 'MG123',
    statusCallbackUrl: 'https://fn.example/provider-webhook/twilio/ep-1',
    segments: smsSegments,
    ratePerSegmentMicros: () => 7900,
    fetch: twilio.doFetch,
  });
  return {
    twilio,
    channel,
    to: { kind: 'address' as const, value: '+15558675310' },
    delivered: async () => twilio.posted.map((p) => ({ text: p.form.get('Body') ?? '' })),
    breakNext: () => twilio.answerNext(new Error('ECONNRESET super-secret-token')),
  };
}

runChannelContract('twilio (recorded responses)', harness);

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

describe('twilioChannel', () => {
  it('posts to the Messaging Service with the callback and an idempotency token', async () => {
    const h = harness();
    const result = await h.channel.send(msg(h, 'Hi'));
    expect(result).toEqual({
      status: 'sent',
      providerMessageId: 'SM0123456789abcdef0123456789abcdef',
      segments: 1,
      costMicros: 7900,
    });
    const [req] = h.twilio.posted;
    expect(req?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/AC${'0'.repeat(32)}/Messages.json`,
    );
    expect(req?.form.get('MessagingServiceSid')).toBe('MG123');
    expect(req?.form.get('To')).toBe('+15558675310');
    expect(req?.form.get('StatusCallback')).toBe('https://fn.example/provider-webhook/twilio/ep-1');
    expect(req?.headers['I-Twilio-Idempotency-Token']).toBe('n-1');
  });

  it('estimates segments and cost: 161 GSM-7 chars is 2, 71 chars with an emoji is 2', () => {
    const h = harness();
    expect(h.channel.estimate(msg(h, 'a'.repeat(161)))).toEqual({ segments: 2, costMicros: 15800 });
    expect(h.channel.estimate(msg(h, `${'a'.repeat(69)}😀`))).toEqual({
      segments: 2,
      costMicros: 15800,
    });
  });

  it.each([
    ['21610', 'gone', { code: 'unsubscribed' }],
    ['21211', 'failed', { retryable: false, code: 'invalid_number' }],
    ['21614', 'failed', { retryable: false, code: 'invalid_number' }],
    ['30007', 'failed', { retryable: false, code: 'carrier_filtered' }],
  ])('maps Twilio error %s', async (code, status, extra) => {
    const h = harness();
    h.twilio.answerNext({ status: 400, body: fixture(`error-${code}`) });
    expect(await h.channel.send(msg(h, 'Hi'))).toMatchObject({ status, ...extra });
  });

  it('retries 429 and 5xx, not other 4xx', async () => {
    const h = harness();
    h.twilio.answerNext({ status: 429, body: fixture('error-20429') });
    expect(await h.channel.send(msg(h, 'Hi'))).toMatchObject({
      retryable: true,
      code: 'rate_limited',
    });
    h.twilio.answerNext({ status: 503, body: '' });
    expect(await h.channel.send(msg(h, 'Hi'))).toMatchObject({ retryable: true, code: 'http_503' });
    h.twilio.answerNext({ status: 401, body: '{}' });
    expect(await h.channel.send(msg(h, 'Hi'))).toMatchObject({
      retryable: false,
      code: 'http_401',
    });
  });

  it('keeps the auth token out of transport errors', async () => {
    const h = harness();
    h.twilio.answerNext(new Error('ECONNRESET super-secret-token'));
    const result = await h.channel.send(msg(h, 'Hi'));
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });

  it('sends no cost when no rate is given, so the database estimates it', async () => {
    const twilio = fakeTwilio();
    const channel = twilioChannel({
      accountSid: `AC${'0'.repeat(32)}`,
      authToken: 't',
      messagingServiceSid: 'MG1',
      segments: smsSegments,
      fetch: twilio.doFetch,
    });
    const h = harness();
    expect(await channel.send(msg(h, 'Hi'))).toEqual({
      status: 'sent',
      providerMessageId: 'SM0123456789abcdef0123456789abcdef',
      segments: 1,
    });
  });

  it.each([
    ['a bad account sid', { accountSid: 'AC123' }],
    ['an empty token', { authToken: '' }],
    ['a plain-http API base', { apiBase: 'http://evil.example' }],
    ['a plain-http callback', { statusCallbackUrl: 'http://fn.example/x' }],
  ])('rejects %s', (_name, bad) => {
    expect(() =>
      twilioChannel({
        accountSid: `AC${'0'.repeat(32)}`,
        authToken: 't',
        messagingServiceSid: 'MG1',
        segments: smsSegments,
        ...bad,
      }),
    ).toThrow();
  });
});

describe('twilioChannel with an API key', () => {
  it('authenticates as the key while the URL names the account, and refuses a malformed key', async () => {
    const seen: { url: string; auth: string }[] = [];
    const doFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization') ?? '' });
      return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 });
    }) as unknown as typeof fetch;
    const base = {
      accountSid: `AC${'a'.repeat(32)}`,
      authToken: 'secret',
      messagingServiceSid: 'MG1',
      segments: () => ({ segments: 1 }),
      fetch: doFetch,
    };
    const ch = twilioChannel({ ...base, apiKeySid: `SK${'d'.repeat(32)}` });
    await ch.send({
      outboxId: 'o1',
      orgId: 'org',
      channel: 'sms',
      category: 'transactional',
      trigger: 'called',
      to: { kind: 'address', value: '+14155550142' },
      text: 'Hi',
      policy: { hasConsent: true, isSuppressed: false, locationTz: 'UTC' },
    });
    expect(seen[0]!.url).toContain(`/Accounts/AC${'a'.repeat(32)}/`);
    expect(seen[0]!.auth).toBe(`Basic ${btoa(`SK${'d'.repeat(32)}:secret`)}`);
    expect(() => twilioChannel({ ...base, apiKeySid: 'bad' })).toThrow('invalid apiKeySid');
  });
});

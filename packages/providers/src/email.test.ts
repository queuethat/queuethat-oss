import { describe, expect, it } from 'vitest';
import { type ChannelHarness, runChannelContract, zoneAtLocalHour } from './contract.ts';
import { mailpitEmailChannel } from './email.ts';

const from = { email: 'queue@example.test', name: 'Queue' };

/** In-memory Mailpit: records POST /api/v1/send bodies, or answers with a forced status. */
function fakeMailpit() {
  const sent: Array<{
    To: Array<{ Email: string }>;
    Text: string;
    Headers: Record<string, string>;
  }> = [];
  let next: Response | Error | null = null;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const forced = next;
    next = null;
    if (forced instanceof Error) throw forced;
    if (forced) return forced;
    if (String(url) !== 'http://mailpit.test/api/v1/send')
      return new Response('not found', { status: 404 });
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ID: `m${sent.length}` });
  };
  const respondNext = (r: Response | Error) => {
    next = r;
  };
  return { sent, fetch: fetch as typeof globalThis.fetch, respondNext };
}

function harness() {
  const mailpit = fakeMailpit();
  const channel = mailpitEmailChannel({
    baseUrl: 'http://mailpit.test',
    from,
    fetch: mailpit.fetch,
  });
  return {
    mailpit,
    channel,
    to: { kind: 'address' as const, value: 'guest@example.test' },
    delivered: async () => mailpit.sent.map((m) => ({ text: m.Text })),
    breakNext: () => mailpit.respondNext(new Response('unavailable', { status: 503 })),
  };
}

runChannelContract('mailpit email (fake)', harness);

// Against the real mail catcher: MAILPIT_URL=http://127.0.0.1:55324 pnpm test
// (No @types/node here: this package must also typecheck for Deno and the browser.)
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const mailpitUrl = env?.MAILPIT_URL;
if (mailpitUrl) {
  runChannelContract('mailpit email (local Mailpit)', (): ChannelHarness => {
    const to = `guest-${crypto.randomUUID()}@example.test`;
    return {
      channel: mailpitEmailChannel({ baseUrl: mailpitUrl, from }),
      to: { kind: 'address', value: to },
      async delivered() {
        const search = await fetch(
          new URL(`/api/v1/search?query=to:${encodeURIComponent(to)}`, mailpitUrl),
        );
        const { messages } = (await search.json()) as { messages: Array<{ ID: string }> };
        return Promise.all(
          messages.map(async ({ ID }) => {
            const message = await fetch(new URL(`/api/v1/message/${ID}`, mailpitUrl));
            return { text: ((await message.json()) as { Text: string }).Text };
          }),
        );
      },
    };
  });
}

describe('mailpitEmailChannel', () => {
  const base = {
    outboxId: 'n-1',
    orgId: 'org-1',
    channel: 'email' as const,
    category: 'transactional' as const,
    trigger: 'called' as const,
    subject: "It's your turn",
    text: "It's your turn: A012.",
    policy: { hasConsent: true, isSuppressed: false, locationTz: zoneAtLocalHour(12) },
  };

  it('tags the message with its outbox id and returns the Mailpit id', async () => {
    const h = harness();
    expect(await h.channel.send({ ...base, to: h.to })).toEqual({
      status: 'sent',
      providerMessageId: 'm1',
      costMicros: 0,
    });
    expect(h.mailpit.sent[0]?.Headers).toEqual({ 'X-Outbox-Id': 'n-1' });
    expect(h.mailpit.sent[0]?.To).toEqual([{ Email: 'guest@example.test' }]);
  });

  it('offers one-click unsubscribe when the message has an endpoint', async () => {
    const h = harness();
    await h.channel.send({
      ...base,
      to: h.to,
      unsubscribeUrl: 'https://x/unsubscribe?n=n-1&t=abc',
    });
    expect(h.mailpit.sent[0]?.Headers).toEqual({
      'X-Outbox-Id': 'n-1',
      'List-Unsubscribe': '<https://x/unsubscribe?n=n-1&t=abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('does not retry a rejected request', async () => {
    const h = harness();
    h.mailpit.respondNext(new Response('bad address', { status: 400 }));
    expect(await h.channel.send({ ...base, to: h.to })).toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'http_400',
    });
  });

  it('retries when Mailpit is unreachable', async () => {
    const h = harness();
    h.mailpit.respondNext(new TypeError('fetch failed'));
    expect(await h.channel.send({ ...base, to: h.to })).toMatchObject({
      status: 'failed',
      retryable: true,
      code: 'network_error',
    });
  });

  it('refuses a push recipient', async () => {
    const h = harness();
    const to = {
      kind: 'push' as const,
      endpoint: 'https://fcm.googleapis.com/x',
      p256dh: 'p',
      auth: 'a',
    };
    expect(await h.channel.send({ ...base, to })).toMatchObject({
      status: 'failed',
      code: 'unsupported_recipient',
    });
    expect(h.mailpit.sent).toEqual([]);
  });
});

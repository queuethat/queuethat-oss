import { describe, expect, it } from 'vitest';
import postmarkFx from '../../../../tests/fixtures/providers/email/postmark.json';
import resendFx from '../../../../tests/fixtures/providers/email/resend.json';
import type { NotificationChannel, OutboundMessage } from '../channel.ts';
import { runChannelContract, zoneAtLocalHour } from '../contract.ts';
import { postmarkEmailChannel } from './postmark.ts';
import { resendEmailChannel } from './resend.ts';

type Fixture = { status: number; body: unknown };
type Call = {
  url: string;
  headers: Record<string, string>;
  body: {
    TextBody?: string;
    text?: string;
    Metadata?: { outbox_id: string };
    From?: string;
    from?: string;
    ReplyTo?: string;
    reply_to?: string;
    Headers?: Array<{ Name: string; Value: string }>;
    headers?: Record<string, string>;
  };
  ok: boolean;
};
const from = { email: 'queue@shop.example', name: 'Shop "Queue"' };

/** Records requests and answers with the next forced fixture, else the `sent` one. */
function fakeProvider(fx: { sent: Fixture }) {
  const calls: Call[] = [];
  let next: Fixture | Error | null = null;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const forced = next;
    next = null;
    if (forced instanceof Error) throw forced;
    const r = forced ?? fx.sent;
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Call['body'],
      ok: r.status < 300,
    });
    return Response.json(r.body, { status: r.status });
  };
  return {
    calls,
    fetch: fetch as typeof globalThis.fetch,
    respondNext: (r: Fixture | Error) => void (next = r),
  };
}

const adapters = [
  {
    name: 'postmark',
    fx: postmarkFx as Record<string, Fixture>,
    make: (fetch: typeof globalThis.fetch, replyTo?: string): NotificationChannel =>
      postmarkEmailChannel({ apiKey: 'pm-secret', from, replyTo, fetch }),
    text: (c: Call) => c.body.TextBody ?? '',
    idempotency: (c: Call) => c.body.Metadata?.outbox_id ?? '',
  },
  {
    name: 'resend',
    fx: resendFx as Record<string, Fixture>,
    make: (fetch: typeof globalThis.fetch, replyTo?: string): NotificationChannel =>
      resendEmailChannel({ apiKey: 're-secret', from, replyTo, fetch }),
    text: (c: Call) => c.body.text ?? '',
    idempotency: (c: Call) => c.headers['Idempotency-Key'] as string,
  },
];

const base: OutboundMessage = {
  outboxId: 'n-1',
  orgId: 'org-1',
  channel: 'email',
  category: 'transactional',
  trigger: 'called',
  to: { kind: 'address', value: 'guest@example.test' },
  subject: "It's your turn",
  text: "It's your turn: A012.",
  policy: { hasConsent: true, isSuppressed: false, locationTz: zoneAtLocalHour(12) },
};

for (const a of adapters) {
  runChannelContract(`${a.name} email (recorded fixtures)`, () => {
    const p = fakeProvider(a.fx as { sent: Fixture });
    return {
      channel: a.make(p.fetch),
      to: base.to,
      delivered: async () => p.calls.filter((c) => c.ok).map((c) => ({ text: a.text(c) })),
      breakNext: () => p.respondNext(a.fx.unavailable!),
    };
  });

  describe(`${a.name} adapter`, () => {
    const setup = (replyTo?: string) => {
      const p = fakeProvider(a.fx as { sent: Fixture });
      return { p, channel: a.make(p.fetch, replyTo) };
    };

    it('returns the provider message id and carries the outbox id', async () => {
      const { p, channel } = setup();
      const res = await channel.send(base);
      expect(res).toMatchObject({ status: 'sent', costMicros: 0 });
      expect((res as { providerMessageId: string }).providerMessageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(a.idempotency(p.calls[0]!)).toBe('n-1');
    });

    it('sends the org From and Reply-To, quoting the display name', async () => {
      const { p, channel } = setup('help@shop.example');
      await channel.send(base);
      const body = p.calls[0]!.body;
      expect(body.From ?? body.from).toBe('"Shop Queue" <queue@shop.example>');
      expect(body.ReplyTo ?? body.reply_to).toBe('help@shop.example');
    });

    it('offers one-click unsubscribe only over https', async () => {
      const { p, channel } = setup();
      await channel.send({ ...base, unsubscribeUrl: 'https://x/unsubscribe?n=n-1' });
      await channel.send({ ...base, unsubscribeUrl: 'http://x/unsubscribe?n=n-1' });
      const headers = (c: Call) =>
        c.body.Headers
          ? Object.fromEntries(c.body.Headers.map((h) => [h.Name, h.Value]))
          : (c.body.headers ?? {});
      expect(headers(p.calls[0]!)['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(headers(p.calls[1]!)['List-Unsubscribe']).toBeUndefined();
    });

    it('refuses a recipient that could address several people, without calling out', async () => {
      const { p, channel } = setup();
      for (const value of [
        'a@x.test,victim@y.test',
        'Bob <a@x.test>',
        'a@x.test\r\nBcc: v@y.test',
      ]) {
        expect(await channel.send({ ...base, to: { kind: 'address', value } })).toMatchObject({
          status: 'failed',
          retryable: false,
          code: 'invalid_recipient',
        });
      }
      expect(p.calls).toEqual([]);
    });

    it('drops an unsubscribe URL that could inject header targets', async () => {
      const { p, channel } = setup();
      await channel.send({ ...base, unsubscribeUrl: 'https://x/u?a>, <https://evil.test' });
      const c = p.calls[0]!;
      expect(JSON.stringify(c.body)).not.toContain('List-Unsubscribe');
    });

    it('retries a 429 (AC2)', async () => {
      const { p, channel } = setup();
      p.respondNext(a.fx.rateLimited!);
      expect(await channel.send(base)).toMatchObject({ status: 'failed', retryable: true });
    });

    it('does not retry an invalid address and says so (AC3)', async () => {
      const { p, channel } = setup();
      p.respondNext(a.fx.invalidAddress!);
      expect(await channel.send(base)).toMatchObject({
        status: 'failed',
        retryable: false,
        code: 'invalid_recipient',
      });
    });

    it('does not retry a rejected key and never echoes it', async () => {
      const { p, channel } = setup();
      p.respondNext((a.fx.badToken ?? a.fx.badKey)!);
      const res = await channel.send(base);
      expect(res).toMatchObject({ status: 'failed', retryable: false });
      expect(JSON.stringify(res)).not.toMatch(/secret/);
    });

    it('retries when the provider is unreachable', async () => {
      const { p, channel } = setup();
      p.respondNext(new TypeError('fetch failed'));
      expect(await channel.send(base)).toMatchObject({
        status: 'failed',
        retryable: true,
        code: 'network_error',
      });
    });
  });
}

describe('resend adapter specifics', () => {
  it('treats a non-address 422 as a plain request error and a 409 as retryable', async () => {
    const p = fakeProvider(resendFx as { sent: Fixture });
    const channel = resendEmailChannel({ apiKey: 'k', from, fetch: p.fetch });
    p.respondNext(resendFx.otherValidation);
    expect(await channel.send(base)).toMatchObject({ retryable: false, code: 'http_422' });
    p.respondNext(resendFx.concurrent);
    expect(await channel.send(base)).toMatchObject({ retryable: true, code: 'http_409' });
  });
});

describe('postmark adapter specifics', () => {
  it('maps an inactive recipient to invalid_recipient', async () => {
    const p = fakeProvider(postmarkFx as { sent: Fixture });
    const channel = postmarkEmailChannel({ apiKey: 'k', from, fetch: p.fetch });
    p.respondNext(postmarkFx.inactiveRecipient);
    expect(await channel.send(base)).toMatchObject({ code: 'invalid_recipient', retryable: false });
  });
});

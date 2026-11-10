import { describe, expect, it } from 'vitest';
import { runChannelContract, zoneAtLocalHour } from '../contract.ts';
import { telegramChannel } from './channel.ts';

const TOKEN = '123:secret-token';

/** In-memory Bot API: records sendMessage calls, or answers with a forced response. */
function fakeBotApi() {
  const sent: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  let next: Response | Error | null = null;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const forced = next;
    next = null;
    if (forced instanceof Error) throw forced;
    if (forced) return forced;
    if (String(url) !== `https://bot.test/bot${TOKEN}/sendMessage`)
      return new Response('{}', { status: 404 });
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: sent.length } });
  };
  return {
    sent,
    fetch: fetch as typeof globalThis.fetch,
    respondNext: (r: Response | Error) => (next = r),
  };
}

function harness() {
  const api = fakeBotApi();
  return {
    api,
    channel: telegramChannel({ botToken: TOKEN, apiBase: 'https://bot.test', fetch: api.fetch }),
    to: { kind: 'address' as const, value: 'tg:4242' },
    delivered: async () => api.sent.map((m) => ({ text: m.text })),
    breakNext: () => api.respondNext(Response.json({ ok: false }, { status: 502 })),
  };
}

runChannelContract('telegram (fake Bot API)', harness);

function message(h: ReturnType<typeof harness>, overrides = {}) {
  return {
    outboxId: crypto.randomUUID(),
    orgId: crypto.randomUUID(),
    channel: 'telegram' as const,
    category: 'transactional' as const,
    trigger: 'called' as const,
    to: h.to,
    text: 'You are up',
    url: 'https://q.test/v/tok',
    policy: { hasConsent: true, isSuppressed: false, locationTz: zoneAtLocalHour(12) },
    ...overrides,
  };
}

describe('telegramChannel', () => {
  it('sends the text with a deep link button to the status page', async () => {
    const h = harness();
    await h.channel.send(message(h));
    expect(h.api.sent[0]).toMatchObject({
      chat_id: '4242',
      reply_markup: { inline_keyboard: [[{ url: 'https://q.test/v/tok' }]] },
    });
  });

  it('answers gone when the guest blocked the bot', async () => {
    const h = harness();
    h.api.respondNext(
      Response.json(
        { ok: false, description: 'Forbidden: bot was blocked by the user' },
        { status: 403 },
      ),
    );
    expect(await h.channel.send(message(h))).toMatchObject({ status: 'gone', code: 'bot_blocked' });
  });

  it('retries 429 with retry_after and fails 400 for good', async () => {
    const h = harness();
    h.api.respondNext(
      Response.json({ ok: false, parameters: { retry_after: 7 } }, { status: 429 }),
    );
    expect(await h.channel.send(message(h))).toMatchObject({
      status: 'failed',
      retryable: true,
      code: 'rate_limited',
      message: expect.stringContaining('retry_after=7'),
    });
    h.api.respondNext(Response.json({ ok: false, description: 'chat not found' }, { status: 400 }));
    expect(await h.channel.send(message(h))).toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'http_400',
    });
  });

  it('never leaks the bot token in a network error', async () => {
    const h = harness();
    h.api.respondNext(new Error(`fetch failed: https://bot.test/bot${TOKEN}/sendMessage`));
    const result = await h.channel.send(message(h));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('refuses a non-telegram address', async () => {
    const h = harness();
    const result = await h.channel.send(
      message(h, { to: { kind: 'address', value: '+14155550123' } }),
    );
    expect(result).toMatchObject({ status: 'failed', retryable: false });
  });
});

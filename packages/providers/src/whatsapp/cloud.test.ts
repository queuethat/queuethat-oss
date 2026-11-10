import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '../channel.ts';
import { runChannelContract, zoneAtLocalHour } from '../contract.ts';
import { WHATSAPP_GRAPH_VERSION, whatsappCloudChannel } from './cloud.ts';
import send_ok from '../../../../tests/fixtures/providers/whatsapp/send-ok.json' with { type: 'json' };
import error_131047 from '../../../../tests/fixtures/providers/whatsapp/error-131047.json' with { type: 'json' };
import error_131026 from '../../../../tests/fixtures/providers/whatsapp/error-131026.json' with { type: 'json' };
import error_130429 from '../../../../tests/fixtures/providers/whatsapp/error-130429.json' with { type: 'json' };
import error_190 from '../../../../tests/fixtures/providers/whatsapp/error-190.json' with { type: 'json' };

const TOKEN = 'EAAG-secret-token';
const fixtures: Record<string, unknown> = {
  'send-ok': send_ok,
  'error-131047': error_131047,
  'error-131026': error_131026,
  'error-130429': error_130429,
  'error-190': error_190,
};
const fixture = (name: string) => JSON.stringify(fixtures[name]);

/** In-memory Graph API: records /messages calls, or answers with a forced response. */
function fakeGraph() {
  const sent: Array<{
    url: string;
    auth: string | null;
    body: Record<string, unknown> & { text?: { body: string }; type: string };
  }> = [];
  let next: Response | Error | null = null;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const forced = next;
    next = null;
    if (forced instanceof Error) throw forced;
    if (forced) return forced;
    sent.push({
      url: String(url),
      auth: new Headers(init?.headers).get('Authorization'),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(fixture('send-ok'), { status: 200 });
  };
  return {
    sent,
    fetch: fetch as typeof globalThis.fetch,
    respondNext: (r: Response | Error) => (next = r),
  };
}

function harness() {
  const api = fakeGraph();
  return {
    api,
    channel: whatsappCloudChannel({
      phoneNumberId: '1055',
      accessToken: TOKEN,
      apiBase: 'https://graph.test',
      fetch: api.fetch,
    }),
    to: { kind: 'address' as const, value: '+15551234567' },
    delivered: async () => api.sent.map((m) => ({ text: m.body.text?.body ?? m.body.type })),
    breakNext: () => api.respondNext(new Response('{}', { status: 502 })),
  };
}

runChannelContract('whatsapp cloud (fake Graph API)', harness);

function message(
  h: ReturnType<typeof harness>,
  overrides: Partial<OutboundMessage> = {},
): OutboundMessage {
  return {
    outboxId: crypto.randomUUID(),
    orgId: crypto.randomUUID(),
    channel: 'whatsapp',
    category: 'transactional',
    trigger: 'called',
    to: h.to,
    text: 'You are up',
    policy: { hasConsent: true, isSuppressed: false, locationTz: zoneAtLocalHour(12) },
    ...overrides,
  };
}

const template = { name: 'queue_called', language: 'en_US', params: ['A012', 'Sam'] };

describe('whatsappCloudChannel', () => {
  it('AC1: a template row posts the approved name, language and ordered parameters', async () => {
    const h = harness();
    const res = await h.channel.send(message(h, { whatsapp: { template, windowOpen: false } }));
    expect(res).toMatchObject({
      status: 'sent',
      providerMessageId: expect.stringMatching(/^wamid\./),
    });
    const call = h.api.sent[0]!;
    expect(call.url).toBe(`https://graph.test/${WHATSAPP_GRAPH_VERSION}/1055/messages`);
    expect(call.auth).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toMatchObject({
      to: '15551234567',
      type: 'template',
      template: {
        name: 'queue_called',
        language: { code: 'en_US' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'A012' },
              { type: 'text', text: 'Sam' },
            ],
          },
        ],
      },
    });
  });

  it('sends session text when the window is open, even if a template exists', async () => {
    const h = harness();
    await h.channel.send(message(h, { whatsapp: { template, windowOpen: true } }));
    expect(h.api.sent[0]!.body).toMatchObject({ type: 'text', text: { body: 'You are up' } });
  });

  it.each([
    ['error-131047', 400, false, 'outside_window'], // AC2
    ['error-131026', 400, false, 'undeliverable'],
    ['error-130429', 429, true, 'rate_limited'],
    ['error-190', 401, false, 'auth_error'],
  ])('maps %s', async (name, status, retryable, code) => {
    const h = harness();
    h.api.respondNext(new Response(fixture(name), { status }));
    expect(await h.channel.send(message(h))).toMatchObject({ status: 'failed', retryable, code });
  });

  it('redacts the token from network errors', async () => {
    const h = harness();
    h.api.respondNext(new Error(`fetch failed ${TOKEN}`));
    const res = await h.channel.send(message(h));
    expect(res).toMatchObject({ status: 'failed', retryable: true });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it('rejects a recipient that is not a phone number', async () => {
    const h = harness();
    const res = await h.channel.send(message(h, { to: { kind: 'address', value: 'a@b.test' } }));
    expect(res).toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'unsupported_recipient',
    });
  });

  it('rejects unsafe config at construction', () => {
    const ok = { phoneNumberId: '1055', accessToken: TOKEN };
    expect(() => whatsappCloudChannel({ ...ok, accessToken: '' })).toThrow();
    expect(() => whatsappCloudChannel({ ...ok, phoneNumberId: '1/../x' })).toThrow();
    expect(() => whatsappCloudChannel({ ...ok, apiBase: 'http://evil.test' })).toThrow();
  });
});

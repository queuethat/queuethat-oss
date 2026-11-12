// #920: provider factories with fake settings. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { PROVIDER_FIELDS } from '../../../packages/domain/src/provider-fields.ts';
import type { NotificationChannel } from '../../../packages/providers/src/index.ts';
import { providerFactories } from './factories.ts';

const ENDPOINT = '0a1b2c3d-0000-4000-8000-00000000e001';

/** Complete, valid settings for each provider, keyed the way PROVIDER_FIELDS names them. */
const GOOD: Record<string, { config: Record<string, unknown>; secrets: Record<string, string>; kind: string }> = {
  twilio: {
    kind: 'sms',
    config: { account_sid: `AC${'a'.repeat(32)}`, messaging_service_sid: 'MG123', from_number: '+15005550006' },
    secrets: { auth_token: 'twilio-token-0123456789' },
  },
  telnyx: {
    kind: 'sms',
    config: { messaging_profile_id: 'prof-1' },
    secrets: { api_key: 'telnyx-key-0123456789', webhook_secret: 'cHVibGljLWtleQ==' },
  },
  vonage: {
    kind: 'sms',
    config: { from_number: 'QueueThat' },
    secrets: { api_key: 'abcd1234', api_secret: 'vonage-secret-0123', signing_secret: 'sig-secret-0123456' },
  },
  plivo: {
    kind: 'sms',
    config: { auth_id: 'MAABCDEFGHIJKL', from_number: '+15005550006' },
    secrets: { auth_token: 'plivo-token-0123456789' },
  },
  postmark: {
    kind: 'email',
    config: { sender_email: 'shop@example.com', sender_name: 'The Shop' },
    secrets: { api_key: 'postmark-key-0123456789' },
  },
  resend: {
    kind: 'email',
    config: { sender_email: 'shop@example.com' },
    secrets: { api_key: 're_0123456789abcdef' },
  },
  meta: {
    kind: 'whatsapp',
    config: { phone_number_id: '106540352242922' },
    secrets: { access_token: 'EAAG-0123456789', app_secret: 'app-secret-0123' },
  },
};

const factories = providerFactories({ functionsUrl: 'https://x.supabase.co/functions/v1' });

Deno.test('every provider in PROVIDER_FIELDS (bar payments) has a factory and a complete example', () => {
  const specified = ['email', 'sms', 'whatsapp'].flatMap((c) =>
    Object.keys(PROVIDER_FIELDS[c as 'sms']),
  );
  assert.deepEqual([...specified].sort(), Object.keys(factories).sort());
  assert.deepEqual([...specified].sort(), Object.keys(GOOD).sort());
});

for (const [provider, good] of Object.entries(GOOD)) {
  Deno.test(`${provider}: complete own-account settings build a ${good.kind} channel`, () => {
    const channel = factories[provider]!({ mode: 'own', config: good.config, secrets: good.secrets });
    assert.equal(channel?.kind, good.kind);
    assert.equal(channel?.providerName, provider === 'meta' ? 'whatsapp-cloud' : provider);
  });

  Deno.test(`${provider}: a missing required field, or a mode other than own, gives no channel`, () => {
    const spec = Object.values(PROVIDER_FIELDS).map((p) => p[provider]).find(Boolean)!;
    for (const key of spec.required) {
      const config = { ...good.config };
      const secrets = { ...good.secrets };
      delete config[key];
      delete secrets[key];
      assert.equal(factories[provider]!({ mode: 'own', config, secrets }), null, `without ${key}`);
    }
    assert.equal(factories[provider]!({ mode: 'platform', config: good.config, secrets: {} }), null);
  });
}

Deno.test('a value the adapter refuses gives no channel and does not throw', () => {
  const bad = { ...GOOD.twilio!.config, account_sid: 'not-a-sid' };
  assert.equal(factories.twilio!({ mode: 'own', config: bad, secrets: GOOD.twilio!.secrets }), null);
});

Deno.test('org config cannot redirect the API origin; only the deployment option can', async () => {
  const seen: string[] = [];
  const fakeFetch = ((url: string) => {
    seen.push(String(url));
    return Promise.resolve(new Response(JSON.stringify({ sid: 'SM1', num_segments: '1' }), { status: 201 }));
  }) as unknown as typeof fetch;
  const hostile = providerFactories({ fetch: fakeFetch, apiBase: { twilio: 'http://127.0.0.1:9999' } });
  const channel = hostile.twilio!({
    mode: 'own',
    config: { ...GOOD.twilio!.config, apiBase: 'https://evil.test', api_base: 'https://evil.test' },
    secrets: GOOD.twilio!.secrets,
  })!;
  await channel.send({
    outboxId: 'o1', orgId: 'org', channel: 'sms', category: 'transactional', trigger: 'called',
    to: { kind: 'address', value: '+14155550142' }, text: 'Hi',
    policy: { hasConsent: true, isSuppressed: false, locationTz: 'UTC' },
  });
  assert.ok(seen.length > 0 && seen.every((u) => u.startsWith('http://127.0.0.1:9999/')), seen.join());
});

Deno.test('the delivery-report URL is built only from the stored endpoint id and an https gateway', async () => {
  const bodies: string[] = [];
  const fakeFetch = ((_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return Promise.resolve(new Response(JSON.stringify({ sid: 'SM1', num_segments: '1' }), { status: 201 }));
  }) as unknown as typeof fetch;
  const send = async (functionsUrl: string | undefined, endpoint: string) => {
    const channel = providerFactories({ functionsUrl, fetch: fakeFetch, apiBase: { twilio: 'http://127.0.0.1:9' } })
      .twilio!({ mode: 'own', config: { ...GOOD.twilio!.config, endpoint_id: endpoint }, secrets: GOOD.twilio!.secrets })!;
    await channel.send({
      outboxId: 'o1', orgId: 'org', channel: 'sms', category: 'transactional', trigger: 'called',
      to: { kind: 'address', value: '+14155550142' }, text: 'Hi',
      policy: { hasConsent: true, isSuppressed: false, locationTz: 'UTC' },
    });
    return decodeURIComponent(bodies.at(-1)!);
  };
  assert.match(await send('https://x.supabase.co/functions/v1', ENDPOINT), new RegExp(`StatusCallback=https://x.supabase.co/functions/v1/provider-webhook/twilio/${ENDPOINT}`));
  assert.doesNotMatch(await send('http://kong:8000/functions/v1', ENDPOINT), /StatusCallback/);
  assert.doesNotMatch(await send('https://x.supabase.co/functions/v1', '../../evil'), /StatusCallback/);
});

Deno.test('a sender address or name that could add a second From address gives no channel', () => {
  const settings = (config: Record<string, string>) => ({ mode: 'own', config: { ...GOOD.resend!.config, ...config }, secrets: GOOD.resend!.secrets });
  assert.equal(factories.resend!(settings({ sender_email: 'Evil <ceo@bank.com>' })), null);
  assert.equal(factories.resend!(settings({ sender_email: 'a@b.co, c@d.co' })), null);
  assert.equal(factories.resend!(settings({ sender_name: 'Shop <ceo@bank.com>' })), null);
  assert.equal(factories.resend!(settings({ sender_name: "Joe's Barber" }))?.kind, 'email');
});

Deno.test('mode platform builds a channel only through the deployment shared sender', () => {
  const calls: unknown[][] = [];
  const fake = { kind: 'sms' } as unknown as NotificationChannel;
  const withShared = providerFactories({
    apiBase: { twilio: 'http://fake' },
    shared: (channel, provider, settings, common) => {
      calls.push([channel, provider, settings.mode, common.apiBase]);
      return provider === 'twilio' ? fake : null;
    },
  });
  const platform = { mode: 'platform', config: {}, secrets: {} };
  assert.equal(withShared.twilio!(platform), fake);
  assert.equal(withShared.telnyx!(platform), null);
  assert.deepEqual(calls[0], ['sms', 'twilio', 'platform', 'http://fake']);
  // own settings never reach the shared sender
  withShared.twilio!({ mode: 'own', config: GOOD.twilio!.config, secrets: GOOD.twilio!.secrets });
  assert.equal(calls.length, 2);
  // a shared sender that throws gives no channel
  const throwing = providerFactories({ shared: () => { throw new Error('bad env'); } });
  assert.equal(throwing.twilio!(platform), null);
  // without one, platform gives none
  assert.equal(factories.twilio!(platform), null);
});

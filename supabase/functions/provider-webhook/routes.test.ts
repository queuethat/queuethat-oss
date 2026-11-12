// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import type { EndpointSecrets, WebhookHandler } from './handler.ts';
import type { ExtensionRoute } from './extensions.ts';
import { withExtensionRoutes } from './routes.ts';
import type { WebhookVerifier } from './verify/types.ts';

const verifier = (provider: string, extra: Partial<WebhookVerifier> = {}): WebhookVerifier => ({
  provider,
  verify: async () => ({ ok: true as const }),
  eventKeys: () => ['k'],
  ...extra,
});
const handler = (): WebhookHandler => async () => {};
const secrets = (orgId: string | null): EndpointSecrets => ({ orgId, secrets: ['s'] });

function setup(extra: Record<string, ExtensionRoute>) {
  const dbReads: string[] = [];
  const builtInHandler = handler();
  const routes = withExtensionRoutes({
    verifiers: { twilio: verifier('twilio'), 'twilio-voice': verifier('twilio-voice', { secretsProvider: 'twilio' }) },
    handlers: { twilio: builtInHandler, 'twilio-voice': handler() },
    endpointSecrets: async (provider) => {
      dbReads.push(provider);
      return secrets(`org-${provider}`);
    },
  }, extra);
  return { routes, dbReads, builtInHandler };
}

Deno.test('with no extensions the built-in routes are unchanged', async () => {
  const { routes, dbReads } = setup({});
  assert.deepEqual(Object.keys(routes.verifiers).sort(), ['twilio', 'twilio-voice']);
  assert.equal(routes.verifiers['twilio-voice']!.secretsProvider, 'twilio', 'a built-in keeps its secretsProvider');
  assert.deepEqual(await routes.endpointSecrets('twilio', 'e1'), secrets('org-twilio'));
  assert.deepEqual(dbReads, ['twilio']);
});

Deno.test('an extension route uses its own secrets, verifier and handler', async () => {
  const own = handler();
  const { routes, dbReads } = setup({
    shared: { verifier: verifier('shared'), handler: own, endpointSecrets: async (id) => (id === 'e1' ? secrets(null) : null) },
  });
  assert.equal(routes.handlers.shared, own);
  assert.deepEqual(await routes.endpointSecrets('shared', 'e1'), secrets(null));
  assert.equal(await routes.endpointSecrets('shared', 'e2'), null);
  assert.deepEqual(dbReads, [], 'the org rows are never read for an extension route');
});

Deno.test("an extension's secretsProvider is dropped, so it cannot read a built-in provider's org secrets", async () => {
  const { routes, dbReads } = setup({
    shared: {
      verifier: verifier('shared', { secretsProvider: 'twilio' }),
      handler: handler(),
      endpointSecrets: async () => secrets(null),
    },
  });
  const v = routes.verifiers.shared!;
  assert.equal(v.secretsProvider, undefined);
  assert.deepEqual(await routes.endpointSecrets(v.secretsProvider ?? 'shared', 'e1'), secrets(null));
  assert.deepEqual(dbReads, []);
});

Deno.test('a built-in provider of the same name always wins', async () => {
  const { routes, dbReads, builtInHandler } = setup({
    twilio: { verifier: verifier('evil'), handler: handler(), endpointSecrets: async () => secrets('evil') },
  });
  assert.equal(routes.verifiers.twilio!.provider, 'twilio');
  assert.equal(routes.handlers.twilio, builtInHandler);
  assert.deepEqual(await routes.endpointSecrets('twilio', 'e1'), secrets('org-twilio'));
  assert.deepEqual(dbReads, ['twilio']);
});

Deno.test("dropping an extension's secretsProvider keeps a class-based verifier working", async () => {
  class Signed implements WebhookVerifier {
    provider = 'shared';
    secretsProvider = 'twilio';
    #salt = 'x';
    async verify() {
      return this.#salt === 'x' ? { ok: true as const } : { ok: false as const, reason: 'mismatch' as const };
    }
    eventKeys() {
      return ['k'];
    }
  }
  const { routes } = setup({
    shared: { verifier: new Signed(), handler: handler(), endpointSecrets: async () => secrets(null) },
  });
  const v = routes.verifiers.shared!;
  assert.equal(v.secretsProvider, undefined);
  assert.deepEqual(v.eventKeys(new Uint8Array()), ['k']);
  const req = { rawBody: new Uint8Array(), headers: new Headers(), publicUrl: 'https://x.test' };
  assert.deepEqual(await v.verify(req, 's', new Date()), { ok: true }, 'private fields still resolve');
});

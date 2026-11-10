// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { supabaseDeps } from './deps.ts';

const ENDPOINT = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const clientReturning = (result: { data?: unknown; error?: { message: string } }) => () => ({
  schema: () => ({ rpc: () => Promise.resolve({ data: null, error: null, ...result }) }),
});
const deps = (result: { data?: unknown; error?: { message: string } }) =>
  supabaseDeps(clientReturning(result), { url: 'http://x', serviceRoleKey: 'k' });

Deno.test('an unknown endpoint is null for every provider, so the route answers 403 not 500', async () => {
  for (const provider of ['square', 'stripe', 'twilio']) {
    assert.equal(await deps({ error: { message: 'not_found' } }).endpointSecrets(provider, ENDPOINT), null);
  }
});

Deno.test('any other database error is still a failure', async () => {
  await assert.rejects(deps({ error: { message: 'connection refused' } }).endpointSecrets('square', ENDPOINT), /connection refused/);
});

Deno.test('a known endpoint returns its signing secrets', async () => {
  const row = { org_id: 'org-a', secrets: { signing: ['k1', '', 'k2'] } };
  assert.deepEqual(await deps({ data: row }).endpointSecrets('square', ENDPOINT), { orgId: 'org-a', secrets: ['k1', 'k2'], verifyToken: undefined });
});

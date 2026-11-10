// D1 (#48): pair-device handler with fake dependencies. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import {
  createPairDeviceHandler,
  type DeviceClaim,
  type PairDeviceDeps,
  RateLimitedError,
} from './handler.ts';

const CLAIM: DeviceClaim = {
  device_id: '11111111-1111-4111-8111-111111111111',
  org_id: '22222222-2222-4222-8222-222222222222',
  location_id: '33333333-3333-4333-8333-333333333333',
  kind: 'display',
  name: 'Lobby TV',
  scopes: [],
};

function fakes(overrides: Partial<PairDeviceDeps> = {}) {
  const calls: string[] = [];
  const users = new Map<string, { email: string; password: string; meta: Record<string, unknown> }>();
  const deps: PairDeviceDeps = {
    redeem: (code, key) => {
      calls.push(`redeem ${code} ${key}`);
      return Promise.resolve(code === '123456' ? CLAIM : null);
    },
    createUser: (email, password, meta) => {
      calls.push(`createUser ${email}`);
      users.set('user-1', { email, password, meta });
      return Promise.resolve('user-1');
    },
    deleteUser: (id) => {
      calls.push(`deleteUser ${id}`);
      users.delete(id);
      return Promise.resolve();
    },
    signIn: (email, password) => {
      calls.push(`signIn ${email}`);
      const user = [...users.values()].find((u) => u.email === email);
      assert.equal(user?.password, password, 'signs in with the password it just set');
      return Promise.resolve({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        token_type: 'bearer',
      });
    },
    registerDevice: (deviceId, userId) => {
      calls.push(`registerDevice ${deviceId} ${userId}`);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, calls, users };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/pair-device', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

Deno.test('a valid code returns a session and the device, with claims in app_metadata', async () => {
  const { deps, calls, users } = fakes();
  const res = await createPairDeviceHandler(deps)(
    post({ code: '123456' }, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.session.refresh_token, 'rt');
  assert.deepEqual(body.device, {
    id: CLAIM.device_id,
    kind: 'display',
    org_id: CLAIM.org_id,
    location_id: CLAIM.location_id,
    name: 'Lobby TV',
  });
  assert.deepEqual(users.get('user-1')?.meta, {
    kind: 'display',
    org_id: CLAIM.org_id,
    location_id: CLAIM.location_id,
    scopes: [],
    device_id: CLAIM.device_id,
  });
  assert.ok((users.get('user-1')?.password.length ?? 0) >= 40, 'random 32-byte password');
  assert.deepEqual(calls, [
    'redeem 123456 203.0.113.7',
    `createUser device-${CLAIM.device_id}@devices.invalid`,
    `signIn device-${CLAIM.device_id}@devices.invalid`,
    `registerDevice ${CLAIM.device_id} user-1`,
  ]);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

Deno.test('AC1: an unknown, expired or used code is a plain 404 and creates no user', async () => {
  const { deps, calls } = fakes();
  const res = await createPairDeviceHandler(deps)(post({ code: '654321' }));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
  assert.deepEqual(calls, ['redeem 654321 unknown']);
});

Deno.test('a malformed body never reaches the database', async () => {
  const { deps, calls } = fakes();
  const handler = createPairDeviceHandler(deps);
  for (const body of ['not json', {}, { code: 123456 }, { code: '12345' }, { code: '12345a' }]) {
    const res = await handler(post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: 'invalid_input' });
  }
  assert.equal((await handler(new Request('http://localhost/', { method: 'GET' }))).status, 405);
  assert.deepEqual(calls, []);
});

Deno.test('rate limiting is a 429', async () => {
  const { deps } = fakes({ redeem: () => Promise.reject(new RateLimitedError()) });
  const res = await createPairDeviceHandler(deps)(post({ code: '123456' }));
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'rate_limited' });
});

Deno.test('the client key prefers cf-connecting-ip', async () => {
  const { deps, calls } = fakes();
  await createPairDeviceHandler(deps)(
    post({ code: '654321' }, { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.7' }),
  );
  assert.deepEqual(calls, ['redeem 654321 198.51.100.1']);
});

Deno.test('if registering fails, the new auth user is deleted', async () => {
  const { deps, calls, users } = fakes({ registerDevice: () => Promise.reject(new Error('boom')) });
  const logs: string[] = [];
  const res = await createPairDeviceHandler({ ...deps, log: (m, cause) => logs.push(`${m}: ${String(cause)}`) })(
    post({ code: '123456' }),
  );
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'unknown' });
  assert.equal(calls.at(-1), 'deleteUser user-1');
  assert.equal(users.size, 0);
  assert.ok(logs.every((m) => !m.includes('123456')), 'the code is never logged');
});

Deno.test('preflight requests get CORS headers', async () => {
  const { deps } = fakes();
  const res = await createPairDeviceHandler(deps)(
    new Request('http://localhost/', { method: 'OPTIONS' }),
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

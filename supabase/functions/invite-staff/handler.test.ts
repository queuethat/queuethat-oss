// 2A-TM1 (#95): invite-staff handler with fake dependencies. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createInviteStaffHandler, DbError, type Invitation, type InviteStaffDeps, mailSafe } from './handler.ts';

const ORG = '22222222-2222-4222-8222-222222222222';
const BODY = { org_id: ORG, email: 'ben@example.test', role: 'staff', display_name: 'Ben' };

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: 'inv-1', org_id: ORG, email: 'ben@example.test', role: 'staff', location_ids: null,
    display_name: 'Ben', expires_at: '2026-11-06T00:00:00Z', accepted_at: null, revoked_at: null,
    token: 'secret-token', ...overrides,
  };
}

function fakes(overrides: Partial<InviteStaffDeps> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const deps: InviteStaffDeps = {
    siteUrl: 'https://app.example.test/',
    createInvitation: (jwt, input) => {
      calls.push(`create ${jwt} ${input.role}`);
      return Promise.resolve(invitation());
    },
    revokeInvitation: (jwt, id) => {
      calls.push(`revoke ${jwt} ${id}`);
      return Promise.resolve();
    },
    inviteContext: () => Promise.resolve({ orgName: 'Demo Barber', inviterName: 'Dana' }),
    sendInvite: (email, redirectTo, name, context) => {
      calls.push(`send ${email} ${redirectTo} ${name} ${context.orgName} ${context.inviterName}`);
      return Promise.resolve();
    },
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { calls, logs, handle: createInviteStaffHandler(deps) };
}

function post(body: unknown, auth: string | null = 'Bearer jwt-1'): Request {
  return new Request('http://localhost/invite-staff', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}

Deno.test('creates the invitation as the caller, mails a link and never returns the token', async () => {
  const { handle, calls } = fakes();
  const res = await handle(post(BODY));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.sent, true);
  assert.equal(json.invitation.token, null);
  assert.deepEqual(calls, [
    'create jwt-1 staff',
    'send ben@example.test https://app.example.test/auth/accept-invite?token=secret-token Ben Demo Barber Dana',
  ]);
});

Deno.test('M3b: passes the invited lines to the database, null when none are given', async () => {
  const seen: (string[] | null)[] = [];
  const { handle } = fakes({
    createInvitation: (_jwt, input) => {
      seen.push(input.queue_ids);
      return Promise.resolve(invitation());
    },
  });
  const line = '6f1d2c3e-1111-4222-8333-444455556666';
  assert.equal((await handle(post({ ...BODY, queue_ids: [line] }))).status, 200);
  assert.equal((await handle(post(BODY))).status, 200);
  assert.deepEqual(seen, [[line], null]);
});

Deno.test('a request without a bearer token is 401 and touches nothing', async () => {
  const { handle, calls } = fakes();
  assert.equal((await handle(post(BODY, null))).status, 401);
  assert.deepEqual(calls, []);
});

Deno.test('a malformed body is 400', async () => {
  const { handle } = fakes();
  assert.equal((await handle(post({ ...BODY, org_id: 'nope' }))).status, 400);
  assert.equal((await handle(post({ ...BODY, location_ids: ['x'] }))).status, 400);
  assert.equal((await handle(post({ ...BODY, queue_ids: ['x'] }))).status, 400);
  assert.equal((await handle(post({ ...BODY, queue_ids: 'all' }))).status, 400);
  assert.equal((await handle(post({ ...BODY, email: 5 }))).status, 400);
});

Deno.test('a full plan answers 402 with the seat limit and mails nothing', async () => {
  const { handle, calls } = fakes({ createInvitation: () => Promise.reject(new DbError('plan_limit_reached', '3')) });
  const res = await handle(post(BODY));
  assert.equal(res.status, 402);
  assert.deepEqual(await res.json(), { error: 'plan_limit_reached', limit: 3 });
  assert.deepEqual(calls, []);
});

Deno.test('database codes map to statuses and nothing is mailed', async () => {
  for (const [code, status] of [['forbidden_role', 403], ['not_found', 404], ['invalid_input', 400], ['rate_limited', 429]] as const) {
    const { handle, calls } = fakes({ createInvitation: () => Promise.reject(new DbError(code)) });
    const res = await handle(post(BODY));
    assert.equal(res.status, status);
    assert.equal((await res.json()).error, code);
    assert.deepEqual(calls, []);
  }
});

Deno.test('an unexpected failure is 500 unknown and the log holds no address or token', async () => {
  const { handle, logs } = fakes({ createInvitation: () => Promise.reject(new Error('boom ben@example.test')) });
  const res = await handle(post(BODY));
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'unknown');
  assert.equal(logs.some((l) => l.includes('ben@') || l.includes('secret-token')), false);
});

Deno.test('an idempotent replay mails nothing', async () => {
  const { handle, calls } = fakes({ createInvitation: () => Promise.resolve(invitation({ token: null })) });
  const json = await (await handle(post(BODY))).json();
  assert.equal(json.sent, false);
  assert.deepEqual(calls, []);
});

Deno.test('a failed send revokes the invitation and answers 502', async () => {
  const { handle, calls, logs } = fakes({ sendInvite: () => Promise.reject(new Error('smtp down')) });
  const res = await handle(post(BODY));
  assert.equal(res.status, 502);
  assert.deepEqual(calls, ['create jwt-1 staff', 'revoke jwt-1 inv-1']);
  assert.equal(logs.some((l) => l.includes('ben@') || l.includes('secret-token')), false);
});

Deno.test('mailSafe strips markup and template characters, collapses lines and caps the length', () => {
  assert.equal(mailSafe('<b>Joe</b>'), 'b Joe /b');
  assert.equal(mailSafe('A {{ .Token }} "B"'), 'A .Token B');
  assert.equal(mailSafe("Joe's  Barbers &\n Sons"), "Joe's Barbers & Sons");
  assert.equal(mailSafe('x'.repeat(200))?.length, 80);
  assert.equal(mailSafe('  '), null);
  assert.equal(mailSafe(null), null);
});

Deno.test('the invite mail gets cleaned names, and none when the lookup fails', async () => {
  const sent: unknown[] = [];
  const base = {
    sendInvite: (_e: string, _r: string, _n: string | null, c: unknown) => {
      sent.push(c);
      return Promise.resolve();
    },
  };
  await fakes({ ...base, inviteContext: () => Promise.resolve({ orgName: '<i>Shop</i>', inviterName: null }) })
    .handle(post(BODY));
  await fakes({ ...base, inviteContext: () => Promise.reject(new Error('db down')) }).handle(post(BODY));
  assert.deepEqual(sent, [
    { orgName: 'i Shop /i', inviterName: null },
    { orgName: null, inviterName: null },
  ]);
});

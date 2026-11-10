import { describe, expect, it } from 'vitest';
import { CliError, client, connection, findUser } from './lib/platform-cli.ts';
import { revoke } from './lib/platform-revoke.ts';

const ID = '11111111-1111-1111-1111-111111111111';

/** A Call that answers by path and records what it was asked. */
function fake(routes) {
  const calls = [];
  const call = async (path, init) => {
    calls.push({ path, init });
    const route = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    if (!route) throw new Error(`unexpected ${path}`);
    const answer = typeof route[1] === 'function' ? route[1](init) : route[1];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { call, calls };
}
const users = (...emails) => ({ users: emails.map((email) => ({ id: ID, email })) });
const rpc = (answer) => ({ '/rest/v1/rpc/platform_revoke_role': answer });

describe('platform:revoke', () => {
  it('removes the role and reports the sessions ended', async () => {
    const { call, calls } = fake({
      '/auth/v1/admin/users': users('Agent@Example.com'),
      ...rpc({ revoked: true, previous_role: 'support', sessions: 2 }),
    });
    const line = await revoke(['agent@example.com'], call);
    expect(line).toMatch(/no longer has platform role support; 2 sessions ended/);
    const sent = calls.at(-1);
    expect(JSON.parse(sent.init.body)).toEqual({ p_user_id: ID, p_allow_last_operator: false });
    expect(sent.init.headers['Content-Profile']).toBe('api');
  });

  it('is a no-op for an already revoked user (still ends sessions)', async () => {
    const { call } = fake({
      '/auth/v1/admin/users': users('a@x.com'),
      ...rpc({ revoked: false, previous_role: null, sessions: 1 }),
    });
    expect(await revoke(['a@x.com'], call)).toMatch(
      /has no platform role\. Nothing to remove; 1 session ended\./,
    );
  });

  it('fails clearly for an unknown user and calls nothing else', async () => {
    const { call, calls } = fake({ '/auth/v1/admin/users': users('someone.else@x.com') });
    await expect(revoke(['nobody@x.com'], call)).rejects.toThrow(
      /No user with email nobody@x\.com\. Nothing changed\./,
    );
    expect(calls).toHaveLength(1);
  });

  it('does not match a substring of another email', async () => {
    const { call } = fake({ '/auth/v1/admin/users': users('xnobody@x.com') });
    await expect(revoke(['nobody@x.com'], call)).rejects.toThrow(/No user/);
  });

  it('refuses the last operator and says how to proceed', async () => {
    const { call } = fake({
      '/auth/v1/admin/users': users('riz@x.com'),
      ...rpc(new CliError('POST failed: 400 {"message":"last_operator"}')),
    });
    const error = await revoke(['riz@x.com'], call).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toMatch(
      /only operator.*platform:grant.*--allow-last-operator.*Nothing changed/s,
    );
  });

  it('passes --allow-last-operator through to the database', async () => {
    const { call, calls } = fake({
      '/auth/v1/admin/users': users('riz@x.com'),
      ...rpc({ revoked: true, previous_role: 'operator', sessions: 0 }),
    });
    expect(await revoke(['riz@x.com', '--allow-last-operator'], call)).toMatch(
      /operator; 0 sessions ended/,
    );
    expect(JSON.parse(calls.at(-1).init.body).p_allow_last_operator).toBe(true);
  });

  it('propagates other database errors', async () => {
    const { call } = fake({
      '/auth/v1/admin/users': users('a@x.com'),
      ...rpc(new CliError('POST failed: 500 boom')),
    });
    await expect(revoke(['a@x.com'], call)).rejects.toThrow(/500 boom/);
  });

  it('rejects bad usage before any call', async () => {
    for (const args of [
      [],
      ['a@x.com', 'b@x.com'],
      ['a@x.com', '--force'],
      ['--allow-last-operator'],
    ]) {
      const { call, calls } = fake({});
      await expect(revoke(args, call)).rejects.toThrow(/Usage: pnpm platform:revoke/);
      expect(calls).toHaveLength(0);
    }
  });
});

describe('platform cli plumbing', () => {
  it('uses hosted credentials, and requires both', () => {
    expect(connection({ SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' })).toEqual({
      url: 'https://x',
      key: 'k',
    });
    expect(() => connection({ SUPABASE_URL: 'https://x' })).toThrow(/Set both/);
    expect(() => connection({ SUPABASE_SERVICE_ROLE_KEY: 'k' })).toThrow(/Set both/);
  });

  it('reads the local stack from supabase status, and explains when it is down', () => {
    const status = () => 'API_URL="http://127.0.0.1:55321"\nSERVICE_ROLE_KEY="srk"\n';
    expect(connection({}, status)).toEqual({ url: 'http://127.0.0.1:55321', key: 'srk' });
    expect(() => connection({}, () => '')).toThrow(/not running/);
    expect(() =>
      connection({}, () => {
        throw new Error('x');
      }),
    ).toThrow(/not running/);
  });

  it('client sends the service role and turns HTTP errors into CliError', async () => {
    let seen;
    const ok = client({ url: 'http://h', key: 'k' }, async (url, init) => {
      seen = { url, init };
      return new Response('{"a":1}', { status: 200 });
    });
    expect(await ok('/p', { headers: { 'Content-Profile': 'api' } })).toEqual({ a: 1 });
    expect(seen.init.headers.apikey).toBe('k');
    expect(seen.init.headers['Content-Profile']).toBe('api');
    const empty = client(
      { url: 'http://h', key: 'k' },
      async () => new Response('', { status: 200 }),
    );
    expect(await empty('/p')).toBeNull();
    const bad = client(
      { url: 'http://h', key: 'k' },
      async () => new Response('nope', { status: 403 }),
    );
    const failure = await bad('/p', { method: 'POST' }).catch((e) => e);
    expect(failure).toBeInstanceOf(CliError);
    expect(failure.message).toMatch(/POST \/p failed: 403 nope/);
  });

  it('findUser matches the email exactly, ignoring case', async () => {
    const { call } = fake({ '/auth/v1/admin/users': users('A@x.com', 'ab@x.com') });
    expect((await findUser(call, 'a@X.com'))?.id).toBe(ID);
    expect(await findUser(call, 'b@x.com')).toBeNull();
  });
});

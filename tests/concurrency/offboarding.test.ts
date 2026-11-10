// 2A-TM2 (#96): after api.remove_member the removed user's refresh token no longer works and their
// still-unexpired access token reads and changes nothing. Real GoTrue and PostgREST, not pgTAP.
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PASSWORD, demo, demoUsers } from '../fixtures/demo.ts';
import { supabaseEnv } from '../e2e/support/env.ts';
import { connect, type Sql } from './db';

let sql: Sql;
const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(env.url, env.serviceRoleKey, noSession);
let victimId: string | undefined;

beforeAll(() => {
  sql = connect(2);
});

afterAll(async () => {
  if (victimId) await admin.auth.admin.deleteUser(victimId);
  await sql.end();
});

describe('offboarding', () => {
  it('cuts refresh and data access at once', async () => {
    const email = `offboard-${randomUUID().slice(0, 8)}@e2e.test`;
    const created = await admin.auth.admin.createUser({
      email,
      password: DEMO_PASSWORD,
      email_confirm: true,
    });
    victimId = created.data.user!.id;
    const inserted = await sql<{ id: string }[]>`
      insert into app.memberships (org_id, user_id, role) values (${demo.orgId}, ${victimId}, 'staff')
      returning id`;
    const membershipId = inserted[0]!.id;

    const victim = createClient(env.url, env.anonKey, noSession);
    const signedIn = await victim.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
    const session = signedIn.data.session!;
    expect((await victim.schema('app').from('locations').select('id')).data).not.toHaveLength(0);

    const owner = createClient(env.url, env.anonKey, noSession);
    await owner.auth.signInWithPassword({ email: demoUsers.owner.email, password: DEMO_PASSWORD });
    const removed = await owner.schema('api').rpc('remove_member', {
      p_membership_id: membershipId,
      p_reason: 'concurrency test',
      p_idempotency_key: randomUUID(),
    });
    expect(removed.error).toBeNull();

    // AC3: the refresh token no longer works.
    const refreshed = await createClient(env.url, env.anonKey, noSession).auth.refreshSession({
      refresh_token: session.refresh_token,
    });
    expect(refreshed.error).not.toBeNull();
    expect(refreshed.data.session).toBeNull();

    // AC2: the access token is still valid for its lifetime, but every check reads memberships.
    const stale = createClient(env.url, env.anonKey, {
      ...noSession,
      global: { headers: { Authorization: `Bearer ${session.access_token}` } },
    });
    expect((await stale.schema('app').from('locations').select('id')).data).toHaveLength(0);
    const call = await stale.schema('api').rpc('call_next', {
      p_queue_id: demo.queues.walkIns,
      p_counter_id: null,
      p_idempotency_key: randomUUID(),
    });
    expect(call.error).not.toBeNull();
  });
});

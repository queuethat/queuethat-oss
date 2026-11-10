import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { supabaseEnv } from './support/env.ts';
import { enforcePrivateOnly } from './support/realtime.ts';
import { noonTz } from './support/clock.ts';
import { testUsers } from './support/users.ts';

/**
 * Runs once per `playwright test`: resets the local database to migrations plus the demo
 * seed, then checks every account in `testUsers` can sign in, so a seed change fails here
 * with one clear message instead of in every signed-in test. Realtime is switched to private
 * channels only, as in production (#457), and every location's clock is pinned to noon. Set `E2E_SKIP_DB_RESET=1` to
 * keep the current data between local reruns.
 */
export default async function globalSetup(): Promise<void> {
  const { url, anonKey } = supabaseEnv();
  if (process.env.E2E_SKIP_DB_RESET !== '1') {
    execFileSync('pnpm', ['db:reset'], { stdio: 'inherit' });
  }
  for (const { email, password } of Object.values(testUsers)) {
    const status = await passwordSignInStatus(url, anonKey, email, password);
    if (status !== 200) {
      throw new Error(
        `${email} cannot sign in (HTTP ${status}). The demo seed and tests/fixtures/demo.ts disagree.`,
      );
    }
  }
  await enforcePrivateOnly();
  await pinLocationClocks();
  if (process.env.CI) await logSlowStatements();
}

/**
 * On CI, has Postgres log every statement that takes over 250 ms and every wait for a lock.
 * Browser shards have failed on a few seconds in which the API answered nothing while the
 * database log stayed empty; with this, the log uploaded for a failed job says whether the
 * database was the slow part. `db reset` recreates the container, so it is set after it.
 */
async function logSlowStatements(): Promise<void> {
  const sql = postgres(
    process.env.E2E_ADMIN_DATABASE_URL ??
      'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres',
    { max: 1, onnotice: () => {} },
  );
  try {
    await sql.unsafe(`alter system set log_min_duration_statement = '250ms'`);
    await sql.unsafe(`alter system set log_lock_waits = on`);
    await sql`select pg_reload_conf()`;
  } finally {
    await sql.end();
  }
}

/**
 * Puts every seeded location's clock at noon (see `noonTz`), so no spec depends on the time of
 * day it runs at. Runs after the sign-in check, on whatever data is there.
 */
async function pinLocationClocks(): Promise<void> {
  const sql = postgres(
    process.env.E2E_ADMIN_DATABASE_URL ??
      'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres',
    { max: 1, onnotice: () => {} },
  );
  try {
    await sql`update app.locations set tz = ${noonTz()}`;
  } finally {
    await sql.end();
  }
}

async function passwordSignInStatus(url: string, anonKey: string, email: string, password: string) {
  // Auth restarts during `db reset`; give it a few seconds to come back.
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (response.status < 500 || attempt >= 20) return response.status;
    } catch (error) {
      if (!(error instanceof TypeError) || attempt >= 20) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

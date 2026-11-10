// #541 security re-review: private.mfa_verification_attempt under a burst of parallel guesses.
// Auth calls the hook once per verify, each on its own connection. These callers run as postgres
// (it can't become supabase_auth_admin locally); the race is the same for any role.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from './db';

let admin: Sql;

beforeAll(() => {
  admin = connect(1);
});

afterAll(async () => {
  await admin.end();
});

describe('mfa_verification_attempt under concurrency', () => {
  it('30 wrong codes at once for one account let at most 4 continue', async () => {
    const account = randomUUID();
    const callers = Array.from({ length: 30 }, () => connect(1));
    try {
      const decisions = await Promise.all(
        callers.map((sql) =>
          sql.begin(async (tx) => {
            const event = {
              factor_id: randomUUID(),
              factor_type: 'totp',
              user_id: account,
              valid: false,
            };
            const [row] =
              await tx`select private.mfa_verification_attempt(${tx.json(event)}) ->> 'decision' as d`;
            return row!.d as string;
          }),
        ),
      );
      expect(decisions.filter((d) => d === 'continue')).toHaveLength(4);
      expect(decisions.filter((d) => d === 'reject')).toHaveLength(26);
    } finally {
      await Promise.all(callers.map((c) => c.end()));
      await admin`delete from private.mfa_failures where user_id = ${account}`;
    }
  });
});

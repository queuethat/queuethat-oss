import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

/** The local Supabase database (supabase/config.toml [db] port). */
export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

/** A pool of `max` real connections; each one is a separate tablet, phone or kiosk. */
export function connect(max: number) {
  return postgres(DATABASE_URL, { max, onnotice: () => {} });
}

export type Sql = ReturnType<typeof connect>;

/**
 * Runs `fn` in one transaction as `role` with `claims`, the way PostgREST runs an RPC request.
 */
export function asCaller<T>(
  sql: Sql,
  role: 'anon' | 'authenticated',
  claims: Record<string, unknown>,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role, ...claims })}, true),
                    set_config('request.jwt.claim.sub', ${String(claims.sub ?? '')}, true)`;
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  }) as Promise<T>;
}

export function asGuest<T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return asCaller(sql, 'anon', {}, fn);
}

export function asStaff<T>(
  sql: Sql,
  userId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
) {
  return asCaller(sql, 'authenticated', { sub: userId, aud: 'authenticated' }, fn);
}

export interface World {
  orgId: string;
  queueId: string;
  staff: [string, string];
  counters: [string, string];
}

/**
 * Commits a fresh org with one always-open queue (no business hours, no capacity, a rate cap
 * high enough for the suite), two staff members and two counters. Visits can't be deleted
 * (app.visits forbid_delete), so every test gets its own org instead of cleaning up.
 */
export async function createWorld(sql: Sql): Promise<World> {
  const orgId = randomUUID();
  const locationId = randomUUID();
  const queueId = randomUUID();
  const staff: [string, string] = [randomUUID(), randomUUID()];
  const counters: [string, string] = [randomUUID(), randomUUID()];
  await sql.begin(async (tx) => {
    await tx`insert into app.organizations (id, name) values (${orgId}, 'Concurrency')`;
    await tx`insert into app.locations (id, org_id, name, slug, tz)
             values (${locationId}, ${orgId}, 'Race track', ${'race-' + locationId}, 'UTC')`;
    await tx`insert into app.queues (id, org_id, location_id, name, ticket_prefix, join_rate_per_min)
             values (${queueId}, ${orgId}, ${locationId}, 'Races', 'R', 10000)`;
    for (const [i, id] of staff.entries()) {
      await tx`insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                                       email_confirmed_at)
               values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
                       'authenticated', ${id + '@concurrency.test'}, '', '{}', '{}', now(), now(),
                       now())`;
      await tx`insert into app.memberships (org_id, user_id, role)
               values (${orgId}, ${id}, 'staff')`;
      await tx`insert into app.counters (id, org_id, location_id, label)
               values (${counters[i]!}, ${orgId}, ${locationId}, ${'Tablet ' + (i + 1)})`;
    }
  });
  return { orgId, queueId, staff, counters };
}

/** One guest join through api.join_queue on its own connection from the pool. */
export function join(
  sql: Sql,
  queueId: string,
  key: string = randomUUID(),
  deviceKey: string | null = null,
) {
  return asGuest(sql, async (tx) => {
    const [row] = await tx`select * from api.join_queue(${queueId}, null, 'Racer', null, null, 1,
                                                        null, ${key}, ${deviceKey})`;
    return row as { display_ticket: string; status: string; token: string | null };
  });
}

/** One staff call_next; resolves to the called visit id, or null when nobody is waiting. */
export function callNext(
  sql: Sql,
  userId: string,
  queueId: string,
  counterId: string,
  key: string,
) {
  return asStaff(sql, userId, async (tx) => {
    const [row] = await tx`select (api.call_next(${queueId}, ${counterId}, ${key})).id as id`;
    return (row?.id ?? null) as string | null;
  });
}

/** One staff add through api.staff_add_visit; resolves to the new visit's id. */
export function staffAdd(sql: Sql, userId: string, queueId: string, key: string = randomUUID()) {
  return asStaff(sql, userId, async (tx) => {
    const [row] = await tx`select (api.staff_add_visit(${queueId}, null, 'Walk-in', null, 1,
                                                       ${key})).id as id`;
    return row!.id as string;
  });
}

/** Staff opens, pauses or closes the queue. */
export function setQueueState(
  sql: Sql,
  userId: string,
  queueId: string,
  state: 'open' | 'paused' | 'closed',
) {
  return asStaff(sql, userId, (tx) => tx`select api.set_queue_state(${queueId}, ${state})`);
}

/** The queue's change counter (queues.version) as seen by a fresh read. */
export async function queueVersion(sql: Sql, queueId: string) {
  const [row] = await sql`select version from app.queues where id = ${queueId}`;
  return Number(row!.version);
}

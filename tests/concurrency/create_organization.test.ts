// #497: api.create_organization under real races. Owners signing up at the same moment with the
// same location name used to pick the same slug, and all but one failed with a unique violation.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, connect, type Sql } from './db';

let admin: Sql;

beforeAll(() => {
  admin = connect(2);
});

afterAll(async () => {
  await admin.end();
});

describe('create_organization under concurrency', () => {
  it('eight owners creating a location with the same name at once all succeed, with distinct slugs', async () => {
    const owners = Array.from({ length: 8 }, () => randomUUID());
    for (const id of owners) {
      await admin`insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                          raw_app_meta_data, raw_user_meta_data, created_at,
                                          updated_at, email_confirmed_at)
                  values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
                          'authenticated', ${id + '@concurrency.test'}, '', '{}', '{}', now(),
                          now(), now())`;
    }
    const name = `Slug race ${randomUUID().slice(0, 8)}`;
    const callers = owners.map(() => connect(1));
    try {
      const made = await Promise.all(
        owners.map((id, i) =>
          asStaff(callers[i]!, id, async (tx) => {
            const [row] = await tx`select location_id from api.create_organization('Race Co',
                                                                                   ${name}, 'UTC')`;
            return row!.location_id as string;
          }),
        ),
      );
      const slugs = await admin<{ slug: string }[]>`
        select slug from app.locations where id = any(${made}::uuid[])`;
      expect(slugs).toHaveLength(8);
      expect(new Set(slugs.map((s) => s.slug)).size).toBe(8);
    } finally {
      await Promise.all(callers.map((c) => c.end()));
    }
  });
});

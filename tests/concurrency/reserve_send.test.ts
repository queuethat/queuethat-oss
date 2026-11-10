// 3-PV6 (#345): api.reserve_send under real races. Dispatchers run as the service role on their own
// connections; the daily cap must hold exactly however they interleave.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createWorld, join, type Sql } from './db';

let admin: Sql;

beforeAll(() => {
  admin = connect(2);
});

afterAll(async () => {
  await admin.end();
});

describe('reserve_send under concurrency', () => {
  it('AC1: 10 concurrent reservations against a cap of 3 allow exactly 3', async () => {
    const world = await createWorld(admin);
    const guest = connect(1);
    const dispatchers = Array.from({ length: 10 }, () => connect(1));
    try {
      await join(guest, world.queueId);
      const [visit] = await admin<{ id: string; org_id: string }[]>`
        select id, org_id from app.visits where queue_id = ${world.queueId}`;
      const [guestRow] = await admin<{ id: string }[]>`
        insert into app.guests (org_id, first_name) values (${visit!.org_id}, 'Gina') returning id`;
      const [contact] = await admin<{ id: string }[]>`
        insert into app.guest_contacts (org_id, guest_id, channel, value, country_code, created_source)
        values (${visit!.org_id}, ${guestRow!.id}, 'phone', '+14155550777', 'US', 'online') returning id`;
      await admin`
        insert into app.channel_limits (org_id, channel, daily_cap, country_allowlist)
        values (${visit!.org_id}, 'sms', 3, '{US}')`;
      const rows = await admin<{ id: string }[]>`
        insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
        select ${visit!.org_id}, ${visit!.id}, 'sms', ${contact!.id}, 'called', 1, 'rs-' || i
        from generate_series(1, 10) i returning id`;

      const decisions = await Promise.all(
        rows.map((r, i) =>
          dispatchers[i]!.begin(async (tx) => {
            await tx.unsafe('set local role service_role');
            const [d] = await tx<
              { decision: string }[]
            >`select decision from api.reserve_send(${r.id})`;
            return d!.decision;
          }),
        ),
      );
      expect(decisions.filter((d) => d === 'allowed')).toHaveLength(3);
      expect(decisions.filter((d) => d === 'cap_reached')).toHaveLength(7);
      const [counter] = await admin<{ sent: number }[]>`
        select sent from app.usage_counters where org_id = ${visit!.org_id} and channel = 'sms'`;
      expect(counter!.sent).toBe(3);
    } finally {
      await guest.end();
      await Promise.all(dispatchers.map((d) => d.end()));
    }
  });
});

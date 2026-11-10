import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// 2B-G2 (#248): a served guest rates the visit from the status page, by keyboard.

const { url, anonKey } = supabaseEnv();
const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

async function join(name: string): Promise<string> {
  const response = await fetch(`${url}/rest/v1/rpc/join_queue`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
      'content-profile': 'api',
    },
    body: JSON.stringify({
      p_queue_id: demo.queues.kids,
      p_service_id: null,
      p_name: name,
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
      p_device_key: randomUUID().replaceAll('-', ''),
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  return ((await response.json()) as { token: string }).token;
}

/** Marks the guest's visit served as the system actor (the console flow is covered elsewhere). */
async function serve(token: string): Promise<void> {
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      const [v] =
        await tx`select id from app.visits where guest_token_hash = private.token_hash(${token})`;
      await tx`select private.set_actor('system', null, 'call')`;
      await tx`update app.visits set status = 'called', called_at = now() where id = ${v!.id}`;
      await tx`select private.set_actor('system', null, 'start')`;
      await tx`update app.visits set status = 'serving', serving_at = now() where id = ${v!.id}`;
      await tx`select private.set_actor('system', null, 'complete')`;
      await tx`update app.visits set status = 'served', finished_at = now() where id = ${v!.id}`;
    });
  } finally {
    await sql.end();
  }
}

test('a served guest submits 5 stars by keyboard and sees a thank-you (AC1, AC2)', async ({
  devices,
}) => {
  const { guest } = devices;
  const token = await join('Feedback');
  await serve(token);
  await guest.goto(`/v/${token}`);

  await expect(guest.getByRole('heading', { name: 'How was your visit?' })).toBeVisible();
  await expectNoSeriousA11yViolations(guest);

  await guest.getByRole('radio', { name: '1 of 5 stars' }).focus();
  for (let i = 0; i < 4; i++) await guest.keyboard.press('ArrowRight');
  await guest.getByRole('button', { name: 'Send feedback' }).press('Enter');
  await expect(guest.getByTestId('feedback-thanks')).toBeVisible();
});

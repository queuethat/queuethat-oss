import postgres from 'postgres';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { guestJoins, openQueue, pickRowAction } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2B-G4 (#250): a guest message badges the staff row within 3 s and the reply reaches the guest.

const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

async function enableChat(queueId: string) {
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`update app.queues set chat_enabled = true where id = ${queueId}`;
  } finally {
    await sql.end();
  }
}

test('AC1: a guest message badges the row and the staff reply reaches the guest', async ({
  devices,
}) => {
  const queue = await freshQueue();
  await enableChat(queue.id);
  const { token } = await guestJoins('Chat Cleo', queue.id);
  const { guest, staff } = devices;
  await openQueue(staff, queue.id);
  await guest.goto(`/v/${token}`);

  await guest.getByRole('button', { name: 'Message the staff' }).click();
  await guest.getByLabel('Your message').fill('Running 5 min late');
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Send' }).click();
  await expect(guest.getByRole('list').getByText('Running 5 min late')).toBeVisible();

  const row = staff.getByTestId('section-waiting').getByTestId('visit');
  await expect(row.getByTestId('chat-badge')).toBeVisible({ timeout: 3_000 });

  await pickRowAction(staff, 'Details');
  await staff.getByRole('button', { name: 'On our way' }).click();
  await expect(guest.getByText('On our way')).toBeVisible({ timeout: 3_000 });
});

import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';

// A5 (#45): managers and up create, edit and archive queues; nothing is deleted.

test('staff see the queues without controls to change them', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/queues');
  await expect(staff.getByRole('heading', { name: 'Walk-ins' })).toBeVisible();
  await expect(
    staff.getByText('Only managers, admins and owners can change queues.'),
  ).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Add a queue' })).toHaveCount(0);
  await expect(staff.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);
});

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test("AC1: a new queue with prefix 'B' gives the next guest ticket B001", async ({ devices }) => {
    const { staff, guest } = devices;
    const { email, slug } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/queues');
    await expect(staff.getByText('No queues yet')).toBeVisible();

    await staff.getByRole('button', { name: 'Add a queue' }).click();
    await staff.getByLabel('Queue name').fill('Barbers');
    await staff.getByLabel('Ticket letters').fill('b1');
    await expect(staff.getByText('Use one to three letters, A to Z.')).toBeVisible();
    await staff.getByLabel('Ticket letters').fill('b');
    await expect(staff.getByText('Tickets read B001, B002 and so on.')).toBeVisible();
    // A new queue shows the basics; the limits and alerts wait behind More options.
    await expect(staff.getByLabel('Most people waiting at once')).toHaveCount(0);
    await staff.getByRole('button', { name: 'More options' }).click();
    await staff.getByLabel('Most people waiting at once').fill('20');
    await expectNoSeriousA11yViolations(staff);
    await staff.getByRole('button', { name: 'Save queue' }).click();
    await expect(staff.getByTestId('queue')).toContainText('Tickets B001 · Up to 20 waiting');

    const pending: Promise<string>[] = [];
    guest.on('response', (response) => {
      if (!response.url().endsWith('/rpc/join_queue') || !response.ok()) return;
      pending.push(
        response.json().then((body) => (body as { display_ticket: string }).display_ticket),
      );
    });
    await guest.goto(`/q/${slug}`);
    await guest.getByLabel('First name').fill('Sam');
    await guest.getByRole('button', { name: 'Join the queue' }).click();
    await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
    // The page moves on as soon as the answer arrives, which can be before its body is read.
    const tickets = await Promise.all(pending);
    expect(tickets).toEqual(['B001']);
  });

  test('edits are saved and archiving hides the queue without deleting it', async ({ devices }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/queues');
    await staff.getByRole('button', { name: 'Add a queue' }).click();
    await staff.getByLabel('Queue name').fill('Repairs');
    await staff.getByRole('button', { name: 'Save queue' }).click();

    await staff.getByRole('button', { name: 'Edit' }).click();
    // Editing starts with the advanced options already open.
    await expect(staff.getByRole('button', { name: 'More options' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await staff.getByLabel('Queue name').fill('Bike repairs');
    await staff.getByLabel('Staff serving this queue').fill('3');
    await staff.getByLabel('Show customers an estimated wait').uncheck();
    await staff.getByRole('button', { name: 'Save queue' }).click();
    // The form closes once the save lands; reloading earlier can cancel the request.
    await expect(staff.getByTestId('queue')).toContainText('Bike repairs');
    await staff.reload();
    await expect(staff.getByTestId('queue')).toContainText('Bike repairs');
    await expect(staff.getByTestId('queue')).toContainText('3 serving · Wait hidden');

    await staff.getByRole('button', { name: 'Archive' }).click();
    await staff.getByRole('button', { name: 'Yes, archive' }).click();
    await expect(staff.getByText('No queues yet')).toBeVisible();
    const [queues] = await readAs(email, ['queues?select=name,archived_at']);
    expect(queues).toEqual([{ name: 'Bike repairs', archived_at: expect.any(String) }]);
  });

  test("#492: an owner sets the hourly online-join limit, but not on another business's queue", async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/queues');
    await staff.getByRole('button', { name: 'Add a queue' }).click();
    await staff.getByLabel('Queue name').fill('Busy');
    await staff.getByRole('button', { name: 'More options' }).click();
    await expect(staff.getByLabel('Online joins allowed per hour')).toHaveValue('120');
    await staff.getByLabel('Online joins allowed per hour').fill('300');
    await staff.getByRole('button', { name: 'Save queue' }).click();
    await expect(staff.getByTestId('queue')).toContainText('Busy');
    const [queues] = await readAs(email, ['queues?select=online_joins_per_hour']);
    expect(queues).toEqual([{ online_joins_per_hour: 300 }]);

    const response = await restAs(email, `queues?id=eq.${demo.queues.kids}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ online_joins_per_hour: 1 }),
    });
    expect(await response.json()).toEqual([]);
  });

  test("an owner can't add a queue to another business's location", async () => {
    const { email } = await ownerOfNewBusiness();
    const response = await restAs(email, 'queues', {
      method: 'POST',
      body: JSON.stringify({ org_id: demo.orgId, location_id: demo.locationId, name: 'Sneaky' }),
    });
    expect(response.status).toBe(403);
  });
});

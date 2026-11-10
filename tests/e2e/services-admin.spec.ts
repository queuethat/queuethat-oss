import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';

// A6 (#46): managers and up add, edit, deactivate and reactivate a queue's services.

test('staff see services without controls to change them', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto(`/admin/queues/${demo.queues.walkIns}`);
  await expect(staff.getByRole('heading', { name: 'Services in Walk-ins' })).toBeVisible();
  await expect(staff.getByRole('heading', { name: 'Haircut' })).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Add a service' })).toHaveCount(0);
  await expect(staff.getByRole('button', { name: 'Stop offering' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);
});

test('"Sign out" stays on one line in the header of a 375px phone', async ({ devices }) => {
  const { staff } = devices;
  await staff.setViewportSize({ width: 375, height: 812 });
  await staff.goto('/admin/queues');
  const lines = await staff.getByRole('button', { name: 'Sign out' }).evaluate((button) => {
    const range = document.createRange();
    range.selectNodeContents(button);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lines).toBe(1);
});

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test('AC1: a deactivated service is not offered on the join page', async ({ devices }) => {
    const { staff, guest } = devices;
    const { email, slug } = await ownerOfNewBusiness();
    const queueId = await addQueue(email, 'Salon');
    await signInTo(staff, email, '/admin/queues');
    await staff.getByRole('link', { name: 'Services' }).click();
    await expect(staff.getByText('No services yet')).toBeVisible();

    for (const [name, minutes] of [
      ['Cut', '30'],
      ['Shave', '15'],
      ['Colour', '60'],
    ] as const) {
      await staff.getByRole('button', { name: 'Add a service' }).click();
      await staff.getByLabel('Service name').fill(name);
      await staff.getByLabel('Usual minutes per customer').fill(minutes);
      await staff.getByRole('button', { name: 'Save service' }).click();
      await expect(staff.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    // A service can carry its own ticket prefix, previewed as the form is filled.
    await staff
      .getByTestId('service')
      .filter({ hasText: 'Cut' })
      .getByRole('button', { name: 'Edit' })
      .click();
    await staff.getByLabel('Ticket prefix (optional)').fill('b');
    await expect(staff.getByText('Tickets will look like B001.')).toBeVisible();
    await staff.getByRole('button', { name: 'Save service' }).click();
    await expect(staff.getByRole('heading', { name: 'Cut', exact: true })).toBeVisible();
    const shave = staff.getByTestId('service').filter({ hasText: 'Shave' });
    await shave.getByRole('button', { name: 'Stop offering' }).click();
    await expect(shave).toContainText('Not offered');
    await expectNoSeriousA11yViolations(staff);

    await guest.goto(`/q/${slug}`);
    const options = guest.getByLabel('What do you need?').locator('option');
    await expect(options).toHaveText(['Colour', 'Cut']);

    // Offering it again brings it back; nothing was deleted.
    await shave.getByRole('button', { name: 'Offer again' }).click();
    await expect(shave).not.toContainText('Not offered');
    const [services] = await readAs(email, [`services?select=name&queue_id=eq.${queueId}`]);
    expect(services).toHaveLength(3);
  });

  test('edits are saved', async ({ devices }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    const queueId = await addQueue(email, 'Repairs');
    await restAs(email, 'services', {
      method: 'POST',
      body: JSON.stringify({ ...(await queueOwner(email, queueId)), name: 'Tyres' }),
    });
    await signInTo(staff, email, `/admin/queues/${queueId}`);

    await staff.getByRole('button', { name: 'Edit' }).click();
    await staff.getByLabel('Service name').fill('Tyre change');
    await staff.getByLabel('Usual minutes per customer').fill('25');
    await staff.getByRole('button', { name: 'Save service' }).click();
    // The form closes once the save lands; reloading earlier could beat the write.
    await expect(staff.getByRole('heading', { name: 'Tyre change' })).toBeVisible();
    await staff.reload();
    await expect(staff.getByTestId('service')).toContainText('Tyre change');
    await expect(staff.getByTestId('service')).toContainText('About 25 minutes');
  });

  test("an owner can't change another business's services", async () => {
    const { email } = await ownerOfNewBusiness();
    const response = await restAs(email, `services?id=eq.${demo.services.haircut}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ active: false }),
    });
    expect(await response.json()).toEqual([]);
  });
});

async function addQueue(email: string, name: string): Promise<string> {
  const [locations] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  const response = await restAs(email, 'queues', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ org_id: locations[0]!.org_id, location_id: locations[0]!.id, name }),
  });
  return ((await response.json()) as { id: string }[])[0]!.id;
}

async function queueOwner(email: string, queueId: string) {
  const [queues] = (await readAs(email, [`queues?select=org_id,location_id&id=eq.${queueId}`])) as [
    { org_id: string; location_id: string }[],
  ];
  return { ...queues[0]!, queue_id: queueId };
}

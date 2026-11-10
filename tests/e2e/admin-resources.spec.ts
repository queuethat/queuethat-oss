import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';

// 2A-Q3 (#102): resources of every kind, and which of them can serve a service.

test.use({ staffUser: null });

async function addResource(
  page: import('@playwright/test').Page,
  name: string,
  kind: string,
  seats?: string,
) {
  await page.getByRole('button', { name: 'Add a resource' }).click();
  await page.getByLabel('Resource name').fill(name);
  await page.getByLabel('Kind').selectOption(kind);
  if (seats) await page.getByLabel('Seats').fill(seats);
  await page.getByRole('button', { name: 'Save resource' }).click();
  await expect(page.getByTestId('counter').filter({ hasText: name })).toBeVisible();
}

test('AC1: a room appears in the console picker, and /admin/counters still works', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/resources');
  await expect(staff.getByRole('heading', { name: 'Resources' })).toBeVisible();
  await addResource(staff, 'Room 4', 'room');
  await addResource(staff, 'Table 9', 'table', '4');
  await expect(staff.getByTestId('counter').filter({ hasText: 'Table 9' })).toContainText(
    '4 seats',
  );
  await expectNoSeriousA11yViolations(staff);

  await staff.goto('/admin/counters');
  await expect(staff.getByRole('heading', { name: 'Resources' })).toBeVisible();

  await staff.goto('/staff');
  await staff.getByLabel('My counter').selectOption({ label: 'Room 4' });
  await expect(staff.getByLabel('My counter')).toHaveValue(/.+/);
});

test('a staff resource is saved with the member it names', async ({ devices }) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/resources');
  await staff.getByRole('button', { name: 'Add a resource' }).click();
  await staff.getByLabel('Resource name').fill('Me');
  await staff.getByLabel('Kind').selectOption('staff');
  await staff.getByLabel('Which team member?').selectOption({ index: 1 });
  await staff.getByRole('button', { name: 'Save resource' }).click();
  await expect(staff.getByTestId('counter').filter({ hasText: 'Staff member' })).toBeVisible();
  const [rows] = (await readAs(email, ['counters?select=kind,member_user_id'])) as [
    { kind: string; member_user_id: string }[],
  ];
  expect(rows).toEqual([{ kind: 'staff', member_user_id: expect.any(String) }]);
});

test('AC2: Colour mapped to Chair 2 only gives one service_resources row and shows Chair 2', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  const [[loc]] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  const queue = await restAs(email, 'queues', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ org_id: loc!.org_id, location_id: loc!.id, name: 'Salon' }),
  }).then(async (r) => ((await r.json()) as { id: string }[])[0]!);

  await signInTo(staff, email, '/admin/resources');
  await addResource(staff, 'Chair 1', 'chair');
  await addResource(staff, 'Chair 2', 'chair');

  await staff.goto(`/admin/queues/${queue.id}`);
  await staff.getByRole('button', { name: 'Add a service' }).click();
  await staff.getByLabel('Service name').fill('Colour');
  await staff.getByRole('group', { name: 'Chair' }).getByLabel('Chair 2').check();
  await staff.getByRole('button', { name: 'Save service' }).click();
  await expect(staff.getByTestId('service')).toContainText('Served by Chair 2');

  const [rows] = (await readAs(email, ['service_resources?select=counter:counters(label)'])) as [
    { counter: { label: string } }[],
  ];
  expect(rows).toEqual([{ counter: { label: 'Chair 2' } }]);

  // Clearing the choice means anyone can serve it again.
  await staff.getByRole('button', { name: 'Edit' }).click();
  await staff.getByRole('group', { name: 'Chair' }).getByLabel('Chair 2').uncheck();
  await staff.getByRole('button', { name: 'Save service' }).click();
  await expect(staff.getByTestId('service')).not.toContainText('Served by');
  const [after] = await readAs(email, ['service_resources?select=counter_id']);
  expect(after).toEqual([]);
});

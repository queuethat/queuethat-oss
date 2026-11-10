import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';

// 2B-Q6 (#231): the routing rules admin. The join page flow is in routing-join.spec.ts.

test.use({ staffUser: null });

async function post<T>(email: string, table: string, body: object): Promise<T> {
  const response = await restAs(email, table, {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return ((await response.json()) as T[])[0]!;
}

async function twoQueues(email: string) {
  const [[loc]] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  const where = { org_id: loc!.org_id, location_id: loc!.id };
  const a = await post<{ id: string }>(email, 'queues', { ...where, name: 'Front desk' });
  const b = await post<{ id: string }>(email, 'queues', { ...where, name: 'Licences' });
  const service = await post<{ id: string }>(email, 'services', {
    ...where,
    queue_id: b.id,
    name: 'Licence',
    expected_minutes: 10,
  });
  return { where, a, b, service };
}

test('AC2: the rules reorder by keyboard alone, and the order sticks', async ({ devices }) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  const { where, a, b, service } = await twoQueues(email);
  await post(email, 'routing_rules', {
    ...where,
    rank: 0,
    service_id: service.id,
    target_queue_id: b.id,
  });
  await post(email, 'routing_rules', { ...where, rank: 1, target_queue_id: a.id });
  await signInTo(staff, email, '/admin/routing');

  const rules = staff.getByTestId('routing-rule');
  await expect(rules).toHaveCount(2);
  await expect(rules.first()).toContainText('Service is Licence');
  await expectNoSeriousA11yViolations(staff);

  await staff.getByRole('button', { name: 'Move rule 2 up' }).focus();
  await staff.keyboard.press('Enter');
  await expect(rules.first()).toContainText('Any service');
  await staff.reload();
  await expect(rules.first()).toContainText('Any service → Front desk');
  await expect(staff.getByRole('button', { name: 'Move rule 1 up' })).toBeDisabled();
});

test('AC3: another business sees none of these rules', async ({ devices }) => {
  const { staff } = devices;
  const first = await ownerOfNewBusiness();
  const { where, a } = await twoQueues(first.email);
  await post(first.email, 'routing_rules', { ...where, target_queue_id: a.id });
  const other = await ownerOfNewBusiness();
  await signInTo(staff, other.email, '/admin/routing');
  await expect(staff.getByRole('heading', { name: 'Routing' })).toBeVisible();
  await expect(staff.getByTestId('routing-rule')).toHaveCount(0);
  await expect(staff.getByText('No routing rules yet')).toBeVisible();
});

test('a rule can be added and switched off', async ({ devices }) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  const { service } = await twoQueues(email);
  await signInTo(staff, email, '/admin/routing');
  await staff.getByRole('button', { name: 'Add rule' }).click();
  await staff.getByLabel('Service').selectOption(service.id);
  await staff.getByLabel('Send the guest to').selectOption({ label: 'Licences' });
  await staff.getByRole('button', { name: 'Save' }).click();
  const rule = staff.getByTestId('routing-rule');
  await expect(rule).toContainText('Service is Licence → Licences');
  await rule.getByRole('button', { name: 'Switch off' }).click();
  await expect(rule).toContainText('Switched off');
});

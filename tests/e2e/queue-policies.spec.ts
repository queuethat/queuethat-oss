import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';

// 2A-Q9 (#108): admins set a queue's party size and no-show policies; guests pick a party size.

test.use({ staffUser: null });

async function queueOf(email: string, name: string) {
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

test('AC1: bounds 2-6 give a stepper that starts at 2 and stops at 6', async ({ devices }) => {
  const { staff, guest } = devices;
  const { email, slug } = await ownerOfNewBusiness();
  const queueId = await queueOf(email, 'Tables');
  await signInTo(staff, email, '/admin/queues');
  await staff.getByRole('button', { name: 'Edit' }).click();
  await staff.getByLabel('Ask how many people are in the party').check();
  await staff.getByLabel('Smallest party').fill('2');
  await staff.getByLabel('Largest party').fill('6');
  await expectNoSeriousA11yViolations(staff);
  await staff.getByRole('button', { name: 'Save queue' }).click();
  await expect(staff.getByRole('heading', { name: 'Tables' })).toBeVisible();

  await guest.goto(`/q/${slug}`);
  const size = guest.getByRole('group', { name: 'How many people?' });
  await expect(size.getByText('2', { exact: true })).toBeVisible();
  await expect(size.getByRole('button', { name: 'One fewer person' })).toBeDisabled();
  for (let i = 0; i < 4; i++) await size.getByRole('button', { name: 'One more person' }).click();
  await expect(size.getByText('6', { exact: true })).toBeVisible();
  await expect(size.getByRole('button', { name: 'One more person' })).toBeDisabled();
  await size.getByRole('button', { name: 'One fewer person' }).click();

  await guest.getByLabel('First name').fill('Table guest');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\//);
  const [visits] = (await readAs(email, [`visits?select=party_size&queue_id=eq.${queueId}`])) as [
    { party_size: number }[],
  ];
  expect(visits).toEqual([{ party_size: 5 }]);
});

test('a queue that ignores party size shows no stepper', async ({ devices }) => {
  const { guest } = devices;
  const { email, slug } = await ownerOfNewBusiness();
  await queueOf(email, 'Counter');
  await guest.goto(`/q/${slug}`);
  await expect(guest.getByLabel('First name')).toBeVisible();
  await expect(guest.getByRole('group', { name: 'How many people?' })).toHaveCount(0);
});

test('AC2: a warning under 20 seconds is refused, and the copy says guests are warned first', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  const queueId = await queueOf(email, 'Walk-ins');
  await signInTo(staff, email, '/admin/queues');
  await staff.getByRole('button', { name: 'Edit' }).click();
  await expect(staff.getByText(/They get a warning message first/)).toBeVisible();
  await staff.getByLabel('Mark no-shows automatically').check();
  await staff.getByLabel('Warn them this many seconds before').fill('10');
  await expect(staff.getByRole('alert').filter({ hasText: 'at least 20 seconds' })).toBeVisible();
  await staff.getByRole('button', { name: 'Save queue' }).click();
  const [before] = (await readAs(email, [
    `queues?select=auto_no_show_enabled&id=eq.${queueId}`,
  ])) as [{ auto_no_show_enabled: boolean }[]];
  expect(before![0]!.auto_no_show_enabled).toBe(false);

  await staff.getByLabel('Warn them this many seconds before').fill('30');
  await staff.getByLabel('Grace period (minutes)').fill('3');
  await staff.getByLabel('Remind staff after (minutes)').fill('20');
  await staff.getByRole('button', { name: 'Save queue' }).click();
  await expect(staff.getByRole('heading', { name: 'Walk-ins' })).toBeVisible();
  const [after] = (await readAs(email, [
    `queues?select=auto_no_show_enabled,grace_minutes,no_show_warning_seconds,serving_reminder_minutes&id=eq.${queueId}`,
  ])) as [Record<string, unknown>[]];
  expect(after![0]).toEqual({
    auto_no_show_enabled: true,
    grace_minutes: 3,
    no_show_warning_seconds: 30,
    serving_reminder_minutes: 20,
  });
});

import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';

// ORG-6 (#91): owners add, edit and remove closed days and special hours for specific dates.

const isoDay = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test('AC2: staff cannot add or remove exceptions', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/location/hours');
  await expect(staff.getByRole('heading', { name: 'Holidays and special hours' })).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Add a date' })).toHaveCount(0);
});

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test('AC1: a closed range writes one row a day and the join page shows closed', async ({
    devices,
  }) => {
    const { staff, guest } = devices;
    const { email, slug } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/location/hours');
    await staff.getByRole('button', { name: 'Add a date' }).click();
    // A range around today in any time zone, so the location is closed right now.
    await staff.getByLabel('First date').fill(isoDay(-1));
    await staff.getByLabel('Last date').fill(isoDay(1));
    await staff.getByLabel('Note for guests (optional)').fill('Holiday');
    await expectNoSeriousA11yViolations(staff);
    await staff.getByRole('button', { name: 'Save date' }).click();
    await expect(staff.getByTestId('exception')).toHaveCount(3); // a past date sits in the collapsed list
    const [rows] = await readAs(email, ['hours_exceptions?select=closed,note']);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(Array(3).fill({ closed: true, note: 'Holiday' }));

    const [[location]] = (await readAs(email, ['locations?select=id,org_id'])) as [
      { id: string; org_id: string }[],
    ];
    await restAs(email, 'queues', {
      method: 'POST',
      body: JSON.stringify({ org_id: location!.org_id, location_id: location!.id, name: 'Q' }),
    });
    await guest.goto(`/q/${slug}`);
    await expect(guest.getByText('This queue is outside its opening hours.')).toBeVisible();
  });

  test('special hours show the usual hours, and a duplicate date is refused', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/location/hours');
    const date = isoDay(10);
    for (const attempt of [1, 2]) {
      await staff.getByRole('button', { name: 'Add a date' }).click();
      await staff.getByLabel('First date').fill(date);
      await staff.getByLabel('Closed all day').uncheck();
      await staff.getByLabel('Opens').fill('09:00');
      await staff.getByLabel('Closes').fill('13:00');
      await staff.getByRole('button', { name: 'Save date' }).click();
      if (attempt === 2) {
        await expect(staff.getByRole('alert')).toContainText('already has an exception');
        await staff.getByRole('button', { name: 'Cancel' }).click();
      }
    }
    await expect(staff.getByTestId('exception')).toContainText('open 09:00-13:00');
    await staff.getByRole('button', { name: /^Remove the exception on/ }).click();
    await staff.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(staff.getByText('No holidays or special hours')).toBeVisible();
  });
});

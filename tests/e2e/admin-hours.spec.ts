import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, signInTo } from './support/accounts.ts';

// ORG-5 (#90): owners set weekly hours, cross-midnight allowed; staff see them read-only.

test('staff see the hours without controls to change them', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/location/hours');
  await expect(staff.getByRole('heading', { name: 'Opening hours' })).toBeVisible();
  await expect(staff.getByText('Only admins and owners can change opening hours.')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Save hours' })).toHaveCount(0);
  await expect(staff.getByLabel('Closed').first()).toBeDisabled();
  await expectNoSeriousA11yViolations(staff);
});

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test('AC1, AC4: Friday 18:00-02:00 saves as one row and reads Fri 6 pm to Sat 2 am', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/location/hours');
    const friday = staff.getByTestId('day-5');
    await friday.getByLabel('Closed').uncheck();
    await friday.getByLabel('Friday: opens (interval 1)').fill('18:00');
    await friday.getByLabel('Friday: closes (interval 1)').fill('02:00');
    await expect(friday.getByText('+1 day')).toBeVisible();
    await expect(friday.getByTestId('summary')).toHaveText('Fri 6 pm to Sat 2 am');
    await expectNoSeriousA11yViolations(staff);
    await staff.getByRole('button', { name: 'Save hours' }).click();
    await expect(staff.getByRole('status')).toHaveText('Opening hours saved.');
    const [rows] = await readAs(email, ['business_hours?select=weekday,opens,closes']);
    expect(rows).toEqual([{ weekday: 5, opens: '18:00:00', closes: '02:00:00' }]);
  });

  test('AC2: overlapping intervals name the day and write nothing', async ({ devices }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/location/hours');
    const friday = staff.getByTestId('day-5');
    await friday.getByLabel('Closed').uncheck();
    await friday.getByLabel('Friday: opens (interval 1)').fill('18:00');
    await friday.getByLabel('Friday: closes (interval 1)').fill('02:00');
    const saturday = staff.getByTestId('day-6');
    await saturday.getByLabel('Closed').uncheck();
    await saturday.getByLabel('Saturday: opens (interval 1)').fill('01:00');
    await saturday.getByLabel('Saturday: closes (interval 1)').fill('05:00');
    await staff.getByRole('button', { name: 'Save hours' }).click();
    await expect(staff.getByRole('alert')).toContainText('Saturday overlaps another interval');
    const [rows] = await readAs(email, ['business_hours?select=weekday']);
    expect(rows).toEqual([]);
  });

  test('copy Monday to Friday and clearing everything', async ({ devices }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/location/hours');
    await staff.getByTestId('day-1').getByLabel('Closed').uncheck();
    await staff.getByRole('button', { name: 'Copy Monday to Friday' }).click();
    await staff.getByRole('button', { name: 'Save hours' }).click();
    await expect(staff.getByRole('status')).toHaveText('Opening hours saved.');
    const [rows] = await readAs(email, ['business_hours?select=weekday&order=weekday']);
    expect(rows).toEqual([1, 2, 3, 4, 5].map((weekday) => ({ weekday })));
    await staff.getByRole('button', { name: 'Clear all hours' }).click();
    await staff.getByRole('button', { name: 'Clear hours' }).click();
    await expect(staff.getByText('No hours are set')).toBeVisible();
    const [after] = await readAs(email, ['business_hours?select=weekday']);
    expect(after).toEqual([]);
  });
});

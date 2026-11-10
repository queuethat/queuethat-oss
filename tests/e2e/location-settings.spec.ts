import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';

// A4 (#44): owners and admins edit a location's settings; everyone else sees them read-only.

test('AC1: staff see the settings read-only', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/location');
  await expect(staff.getByRole('heading', { name: 'Location settings' })).toBeVisible();
  await expect(staff.getByText('Only admins and owners can change these settings.')).toBeVisible();
  for (const label of ['Location name', 'Street address', 'Time zone', 'New day starts at']) {
    await expect(staff.getByLabel(label)).not.toBeEditable();
  }
  await expect(staff.getByLabel('Location name')).toHaveValue('Demo Barber Main Street');
  await expect(staff.getByLabel(/Show customers' names/)).toBeDisabled();
  await expect(staff.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);
});

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test('AC2: turning on display names warns, saves, and writes an audit row', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/location');

    const toggle = staff.getByLabel(/Show customers' names/);
    await expect(toggle).not.toBeChecked();
    await expect(staff.getByTestId('display-names-warning')).toHaveCount(0);
    await toggle.check();
    await expect(staff.getByTestId('display-names-warning')).toContainText('Everyone in the room');
    await expectNoSeriousA11yViolations(staff);
    await staff.getByRole('button', { name: 'Save settings' }).click();
    await expect(staff.getByRole('status')).toHaveText('Settings saved.');

    const [locations, audit] = await readAs(email, [
      'locations?select=display_names_enabled',
      'audit_log?select=action,before,after&table_name=eq.locations&action=eq.UPDATE',
    ]);
    expect(locations).toEqual([{ display_names_enabled: true }]);
    expect(audit).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ display_names_enabled: false }),
        after: expect.objectContaining({ display_names_enabled: true }),
      }),
    ]);
  });

  test('the on-site join code is switched on with its rotation and persists', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/location');

    const toggle = staff.getByLabel(/Require the code on the waiting-room screen/);
    await expect(toggle).not.toBeChecked();
    await expect(staff.getByLabel(/Change the code every/)).toHaveCount(0);
    await toggle.check();
    await staff.getByLabel(/Change the code every/).fill('10');
    await staff.getByRole('button', { name: 'Save settings' }).click();
    await expect(staff.getByRole('status')).toHaveText('Settings saved.');

    const [locations] = await readAs(email, [
      'locations?select=onsite_code_required,onsite_code_rotate_minutes',
    ]);
    expect(locations).toEqual([{ onsite_code_required: true, onsite_code_rotate_minutes: 10 }]);
  });

  test('edits persist and the header follows the new name', async ({ devices }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/location');

    await expect(staff.getByLabel('Join page address')).not.toBeEditable();
    await staff.getByLabel('Location name').fill('Harbour Road');
    await staff.getByLabel('Contact for customers').fill('+49 30 1234567');
    await staff.getByLabel('Time zone').fill('Europe/Lisbon');
    await staff.getByLabel('New day starts at').fill('03:30');
    await staff.getByRole('button', { name: 'Save settings' }).click();
    await expect(staff.getByRole('status')).toHaveText('Settings saved.');
    await expect(staff.getByTestId('current-location')).toContainText('Harbour Road');

    await staff.reload();
    await expect(staff.getByLabel('Contact for customers')).toHaveValue('+49 30 1234567');
    await expect(staff.getByLabel('Time zone')).toHaveValue('Europe/Lisbon');
    await expect(staff.getByLabel('New day starts at')).toHaveValue('03:30');

    await staff.getByLabel('Time zone').fill('Mars/Olympus');
    await expect(staff.getByText('Pick a time zone from the list.')).toBeVisible();
  });

  test('#478: the join page dials the venue country, not the browser region', async ({
    devices,
  }) => {
    const { staff, guest } = devices;
    const { email, slug } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/location');
    await expect(staff.getByLabel('Country')).toHaveValue('');
    await staff.getByLabel('Country').selectOption({ label: 'United Kingdom' });
    await staff.getByRole('button', { name: 'Save settings' }).click();
    await expect(staff.getByRole('status')).toHaveText('Settings saved.');
    await staff.reload();
    await expect(staff.getByLabel('Country')).toHaveValue('GB');

    await guest.goto(`/q/${slug}`);
    expect(await guest.evaluate(() => navigator.language)).toBe('en-US');
    await expect(guest.getByRole('combobox', { name: 'Country code' })).toHaveValue('GB');
  });

  test("an owner can't change another business's location", async () => {
    const { email } = await ownerOfNewBusiness();
    const response = await restAs(email, `locations?id=eq.${demo.locationId}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ display_names_enabled: true }),
    });
    expect(await response.json()).toEqual([]);
  });
});

test.describe('premises position (2B-Q11)', () => {
  test.use({ staffUser: null });

  test('an owner saves the position and radius; half a position is refused before saving', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/location');

    await staff.getByLabel('Latitude').fill('51.5');
    await expect(staff.getByRole('alert')).toContainText('Enter both a latitude');
    await staff.getByLabel('Longitude').fill('-0.1');
    await staff.getByLabel('Radius in metres').fill('200');
    await expectNoSeriousA11yViolations(staff);
    await staff.getByRole('button', { name: 'Save settings' }).click();
    await expect(staff.getByRole('status')).toHaveText('Settings saved.');

    const [locations] = await readAs(email, ['locations?select=lat,lng,geofence_m']);
    expect(locations).toEqual([{ lat: 51.5, lng: -0.1, geofence_m: 200 }]);
  });
});

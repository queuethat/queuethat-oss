import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// The always-on happy-path recording that CI uploads with every run.
test.use({ video: 'on' });

test('guest, staff and display open the app with no serious axe violations @core', async ({
  devices,
}) => {
  const { guest, staff, display } = devices;
  await Promise.all([
    guest.goto(`/q/${demo.locationSlug}`),
    staff.goto('/staff'),
    display.goto('/display'),
  ]);

  await expect(guest.locator('[data-layout="guest"]')).toBeVisible();
  await expect(staff.locator('[data-layout="staff"]')).toBeVisible();
  await expect(display.locator('[data-layout="display"]')).toBeVisible();

  for (const page of [guest, staff, display]) {
    await expectNoSeriousA11yViolations(page);
  }
});

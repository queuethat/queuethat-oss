import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { openKiosk, service, shop } from './support/kiosk.ts';

// DS-22 (#1026): the kiosk shows where the guest is in the check-in, offers services as large
// tiles and prints the ticket number in the mono face; large-text mode reflows without clipping.

test.use({ staffUser: null });

test('the steps follow the guest, services are tiles, and the ticket is mono', async ({
  devices,
}) => {
  const { staff: kiosk } = devices;
  const { queueId, orgId, code } = await shop();
  const { data: location } = await service
    .schema('app')
    .from('queues')
    .select('location_id')
    .eq('id', queueId)
    .single();
  for (const name of ['Haircut', 'Beard trim']) {
    const { error } = await service.schema('app').from('services').insert({
      org_id: orgId,
      location_id: location!.location_id,
      queue_id: queueId,
      name,
      expected_minutes: 15,
    });
    if (error) throw error;
  }
  await openKiosk(kiosk, code);

  const current = kiosk.locator('[aria-current="step"]');
  await expect(current).toContainText('Start');
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await expect(current).toContainText('Your details');

  const tiles = kiosk.getByRole('group', { name: 'What do you need?' }).getByRole('button');
  await expect(tiles).toHaveCount(2);
  for (const tile of await tiles.all()) {
    expect((await tile.boundingBox())!.height).toBeGreaterThanOrEqual(104);
  }
  await expect(tiles.first()).toHaveAttribute('aria-pressed', 'true');
  await tiles.nth(1).click();
  await expect(tiles.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(tiles.first()).toHaveAttribute('aria-pressed', 'false');
  await expectNoSeriousA11yViolations(kiosk);

  await kiosk.getByLabel('First name').fill('Robin');
  await kiosk.getByRole('button', { name: 'Get my ticket' }).click();
  await expect(current).toContainText('Your ticket');
  const ticket = kiosk.getByTestId('kiosk-ticket').locator('span');
  await expect(ticket).toHaveText(/^K\d+$/);
  await expect(ticket).toHaveCSS('font-family', /Geist Mono/);
});

test('large-text mode reflows the form without clipping', async ({ devices }) => {
  const { staff: kiosk } = devices;
  await kiosk.setViewportSize({ width: 820, height: 1180 });
  await openKiosk(kiosk, (await shop()).code);
  await kiosk.getByTestId('a11y-toggle').click();
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await expect(kiosk.locator('[aria-current="step"]')).toContainText('Your details');
  expect(
    await kiosk.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  const clipped = await kiosk.evaluate(
    () =>
      [...document.querySelectorAll('button, input, h1, h2, li')].filter(
        (el) => el.scrollWidth > el.clientWidth + 1,
      ).length,
  );
  expect(clipped).toBe(0);
  await expectNoSeriousA11yViolations(kiosk);
});

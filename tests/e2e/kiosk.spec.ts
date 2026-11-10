import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { openKiosk, service, shop } from './support/kiosk.ts';

// 2A-KSK1 (#119): the paired tablet's self check-in, in a location of its own per test (see
// support/kiosk.ts). AC4 (a kiosk of location A cannot join location B) is pgTAP: join_queue.test.sql and
// contracts_2a_guest.test.sql.

test.use({ staffUser: null });

test('AC1 + AC2: idle warns at 45 s and extends on request, and 65 s later the form is gone', async ({
  devices,
}) => {
  const { staff: kiosk } = devices;
  await openKiosk(kiosk, (await shop()).code);
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await kiosk.getByLabel('First name').fill('Previous guest');
  await expectNoSeriousA11yViolations(kiosk);

  await kiosk.clock.runFor(46_000);
  const warning = kiosk.getByRole('dialog', { name: 'Still there?' });
  await expect(warning).toContainText('seconds');
  await expectNoSeriousA11yViolations(kiosk);

  // AC2: more time restarts the timer, and what was typed is still there.
  await warning.getByRole('button', { name: 'I need more time' }).click();
  await expect(warning).toHaveCount(0);
  await kiosk.clock.runFor(30_000);
  await expect(kiosk.getByLabel('First name')).toHaveValue('Previous guest');

  // AC1: left alone, the kiosk is at welcome 2 minutes after the extension (#262), and the next guest sees a blank form.
  await kiosk.clock.runFor(111_000);
  await expect(kiosk.getByRole('button', { name: 'Check in' })).toBeVisible();
  await expect(kiosk.getByText('Previous guest')).toHaveCount(0);
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await expect(kiosk.getByLabel('First name')).toHaveValue('');
});

test('a guest checks in, gets a ticket and a QR code, and the screen clears itself @core', async ({
  devices,
}) => {
  const { staff: kiosk } = devices;
  const { queueId, orgId, code } = await shop();
  await openKiosk(kiosk, code);
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await kiosk.getByLabel('First name').fill('Robin');
  await kiosk.getByLabel('How many people?').fill('2');
  for (const button of await kiosk.getByRole('button').all()) {
    const box = await button.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(56);
  }
  await kiosk.getByRole('button', { name: 'Get my ticket' }).click();

  const ticket = kiosk.getByTestId('kiosk-ticket');
  await expect(ticket).toHaveText(/^K\d+$/);
  await expect(kiosk.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expectNoSeriousA11yViolations(kiosk);

  const { data: visits } = await service
    .schema('app')
    .from('visits')
    .select('guest_name, party_size, source')
    .eq('queue_id', queueId)
    .eq('org_id', orgId);
  expect(visits).toEqual([{ guest_name: 'Robin', party_size: 2, source: 'kiosk' }]);

  // Nothing of the last guest is kept: the token is not in storage, and 20 s later it is welcome again.
  expect(await kiosk.evaluate(() => JSON.stringify({ ...localStorage }))).not.toMatch(
    /Robin|\/v\//,
  );
  await kiosk.clock.runFor(21_000);
  await expect(kiosk.getByRole('button', { name: 'Check in' })).toBeVisible();
  await expect(kiosk.getByText('Robin')).toHaveCount(0);
});

test('AC3: a queue paused by staff shows closed within 5 s and cannot be submitted', async ({
  devices,
}) => {
  const { staff: kiosk } = devices;
  const { queueId, code } = await shop();
  await openKiosk(kiosk, code);
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await kiosk.getByLabel('First name').fill('Robin');

  await service.schema('app').from('queues').update({ manual_state: 'paused' }).eq('id', queueId);
  await kiosk.clock.runFor(5_000);
  await expect(kiosk.getByText('We are not taking check-ins right now')).toBeVisible();
  await expect(kiosk.getByRole('button', { name: 'Get my ticket' })).toHaveCount(0);
});

test('the accessibility mode passes the colour contrast checks', async ({ devices }) => {
  const { staff: kiosk } = devices;
  await openKiosk(kiosk, (await shop()).code);
  await kiosk.getByRole('button', { name: 'Accessibility' }).click();
  await expect(kiosk.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
  await expectNoSeriousA11yViolations(kiosk);
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await expectNoSeriousA11yViolations(kiosk);
});

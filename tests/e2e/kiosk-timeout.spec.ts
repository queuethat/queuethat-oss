import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { openKiosk, shop } from './support/kiosk.ts';

// 2B-D5 (#262): spoken guidance and the time-limit warning. speechSynthesis is replaced by a
// recorder, so the spec checks what would be spoken, not the voice.

test.use({ staffUser: null });

test.beforeEach(async ({ devices }) => {
  await devices.staff.addInitScript(() => {
    const spoken: string[] = [];
    (window as unknown as { spoken: string[] }).spoken = spoken;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: (u: { text: string }) => void spoken.push(u.text), cancel: () => {} },
    });
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
      lang = '';
      constructor(public text: string) {}
    };
  });
});

const spoken = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { spoken: string[] }).spoken);

test('AC1: with audio guidance on, the screen and each focused control are spoken', async ({
  devices,
}) => {
  const { staff: kiosk } = devices;
  await openKiosk(kiosk, (await shop()).code);
  await kiosk.getByTestId('a11y-toggle').click();
  await kiosk.getByTestId('audio-toggle').click();
  await expect.poll(() => spoken(kiosk)).toContain('Welcome. Press Check in to start.');

  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await expect
    .poll(() => spoken(kiosk))
    .toContain('Check-in. Enter your first name, then press Get my ticket.');
  await kiosk.getByLabel('First name').focus();
  await expect.poll(() => spoken(kiosk)).toContain('First name');
});

test('AC2: 20 s before the reset a warning is spoken and shown, and more time prevents the reset', async ({
  devices,
}) => {
  const { staff: kiosk } = devices;
  await openKiosk(kiosk, (await shop()).code);
  await kiosk.getByTestId('a11y-toggle').click();
  await kiosk.getByTestId('audio-toggle').click();
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await kiosk.getByLabel('First name').fill('Robin');

  await kiosk.clock.runFor(46_000);
  const warning = kiosk.getByRole('dialog', { name: 'Still there?' });
  await expect(warning).toContainText('19 seconds');
  await expect.poll(() => spoken(kiosk)).toContain('Still there? I need more time');
  await expectNoSeriousA11yViolations(kiosk);

  await warning.getByRole('button', { name: 'I need more time' }).click();
  // Two more minutes before the warning returns: a minute on, nothing has changed.
  await kiosk.clock.runFor(60_000);
  await expect(warning).toHaveCount(0);
  await expect(kiosk.getByLabel('First name')).toHaveValue('Robin');
});

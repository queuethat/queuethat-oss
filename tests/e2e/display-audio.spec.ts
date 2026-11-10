import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { newCode, pair, servePairDevice } from './support/pairing.ts';

// 2A-DSP (#121): the TV can chime and speak calls. Browsers keep audio locked until a tap, so a
// TV that comes back with sound on shows a "Tap to enable sound" banner. Playing audio itself is
// the browser's job; this spec covers the gate and the saved choice.

test('sound is off by default, remembered per device, and gated behind a tap', async ({
  devices,
}) => {
  const { display } = devices;
  await servePairDevice(display);
  await display.goto('/display');
  await pair(display, await newCode('display'));
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();

  const controls = display.getByTestId('sound-controls');
  await expect(controls.getByLabel('Sound')).toHaveValue('off');
  await expect(controls.getByRole('button', { name: 'Tap to enable sound' })).toHaveCount(0);

  await controls.getByLabel('Sound').selectOption('chime-speech');
  await expect(controls.getByRole('button', { name: 'Tap to enable sound' })).toBeVisible();
  await expectNoSeriousA11yViolations(display);

  // A reload keeps the choice but audio is locked again, so the banner returns.
  await display.reload();
  await expect(display.getByTestId('sound-controls').getByLabel('Sound')).toHaveValue(
    'chime-speech',
  );
  const gate = display.getByRole('button', { name: 'Tap to enable sound' });
  await expect(gate).toBeVisible();
  await gate.click();
  await expect(gate).toHaveCount(0);
  await expect(display.getByRole('button', { name: 'Test sound' })).toBeVisible();
});

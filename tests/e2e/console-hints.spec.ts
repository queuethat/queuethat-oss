import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// DS-18 (#1022): one slim line of hints the first time a console opens on a browser.
test('the console shows its hints once and remembers a dismissal', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/staff');
  const hints = staff.getByTestId('console-hints');
  await expect(hints.getByText('Call next.')).toBeVisible();
  await expect(hints.getByText('Undo.')).toBeVisible();
  await expect(hints.getByText('Shortcuts.')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  // Nothing is blocked while they are up: the console behind them is still usable.
  await expect(staff.getByRole('tab', { name: 'Walk-ins' })).toBeEnabled();

  await hints.getByRole('button', { name: 'Got it' }).click();
  await expect(staff.getByTestId('console-hints')).toHaveCount(0);
  await staff.reload();
  await expect(staff.getByRole('tab', { name: 'Walk-ins' })).toBeVisible();
  await expect(staff.getByTestId('console-hints')).toHaveCount(0);
});

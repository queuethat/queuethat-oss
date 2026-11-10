import { expect, test } from './fixtures.ts';
import { guestJoins, openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2B-S3 (#273): keyboard shortcuts on the staff console.

test('AC1: typing n in the add-guest name field calls nobody', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Typing Tia', queue.id);
  await openQueue(staff, queue.id);

  await staff.keyboard.press('a');
  const dialog = staff.getByRole('dialog', { name: /^Add a guest/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').pressSequentially('nnn');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(1);
  await expect(staff.getByTestId('section-called').getByTestId('visit')).toHaveCount(0);
});

test('AC2: complete on a waiting row does nothing, n calls the next guest', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Next Nia', queue.id);
  await openQueue(staff, queue.id);
  await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(1);

  await staff.keyboard.press('j');
  await staff.keyboard.press('c');
  await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(1);
  await staff.keyboard.press('n');
  await expect(staff.getByTestId('section-called').getByTestId('visit')).toHaveCount(1);
  await staff.keyboard.press('u');
  await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(1);
});

test('AC3: with single-key shortcuts off, n does nothing; ? opens the help to turn them on', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Off Olu', queue.id);
  await openQueue(staff, queue.id);

  await staff.keyboard.press('?');
  const help = staff.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await help.getByLabel('Use single-key shortcuts').uncheck();
  await help.getByRole('button', { name: 'Close' }).click();
  await staff.keyboard.press('n');
  await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(1);
  await expect(staff.getByTestId('section-called').getByTestId('visit')).toHaveCount(0);
});

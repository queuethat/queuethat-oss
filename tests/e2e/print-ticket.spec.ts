import { expect, test } from './fixtures.ts';
import { openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2B-D3 (#260): staff print a ticket after adding a walk-in. window.print is replaced by a
// recorder that measures the slip in print media, as a real dialog would block the page.

test('AC1: Print ticket after a staff add renders an 80 mm slip with the ticket number', async ({
  devices,
}, testInfo) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await staff.addInitScript(() => {
    (window as unknown as { printed: unknown[] }).printed = [];
    window.print = () => {
      const slip = document.querySelector('.kiosk-slip') as HTMLElement | null;
      (window as unknown as { printed: unknown[] }).printed.push({
        text: slip?.innerText ?? null,
        paper: slip?.dataset.paper ?? null,
        bodyClass: document.body.className,
      });
    };
  });
  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Add guest' }).click();
  const dialog = staff.getByRole('dialog', { name: `Add a guest to ${queue.name}` });
  await dialog.getByLabel('Name (optional)').fill('Walk-in Wes');
  await dialog.getByRole('button', { name: 'Add to the line' }).click();
  await staff
    .getByRole('region', { name: 'Notifications' })
    .getByRole('button', { name: 'Print ticket' })
    .click();

  await expect
    .poll(() => staff.evaluate(() => (window as unknown as { printed: unknown[] }).printed.length))
    .toBe(1);
  const [first] = await staff.evaluate(
    () =>
      (window as unknown as { printed: { text: string; paper: string; bodyClass: string }[] })
        .printed,
  );
  const printed = first!;
  expect(printed.paper).toBe('80');
  expect(printed.bodyClass).toContain('print-slip');
  expect(printed.text).toMatch(/[A-Z]{3}\d{3}/);
  await testInfo.attach('slip-text', { body: printed.text, contentType: 'text/plain' });
});

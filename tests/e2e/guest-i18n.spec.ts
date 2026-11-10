import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { freshQueue } from './support/queues.ts';

// G-9 (#128): guest pages follow the browser's language, can be switched, and the visit keeps it.

test('AC1: an es-MX browser gets Spanish and the visit is created with locale es', async ({
  browser,
}) => {
  const queue = await freshQueue();
  const context = await browser.newContext({ locale: 'es-MX' });
  const guest = await context.newPage();
  const joinBodies: string[] = [];
  guest.on('request', (request) => {
    if (request.url().endsWith('/rpc/join_queue') || request.url().includes('/public-join')) {
      joinBodies.push(request.postData() ?? '');
    }
  });

  await guest.goto(`/q/${demo.locationSlug}`);
  await expect(guest.getByRole('heading', { name: 'Únete a la fila' })).toBeVisible();
  await expect(guest.locator('html')).toHaveAttribute('lang', 'es');
  await guest.getByLabel('Fila', { exact: true }).selectOption(queue.id);
  await guest.getByLabel('Nombre').fill('Sofía');
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Unirme a la fila' }).click();

  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  await expect(guest.getByRole('heading', { name: 'Tu lugar en la fila' })).toBeVisible();
  expect(joinBodies.join('\n')).toMatch(/"(p_)?locale":\s*"es"/);
  await context.close();
});

test('AC2: choosing English sticks across a reload, even in a Spanish browser', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'es-MX' });
  const guest = await context.newPage();
  await guest.goto(`/q/${demo.locationSlug}`);
  await expect(guest.getByRole('heading', { name: 'Únete a la fila' })).toBeVisible();

  await guest.getByLabel('Idioma').selectOption('en');
  await expect(guest.getByRole('heading', { name: 'Join the queue' })).toBeVisible();
  await guest.reload();
  await expect(guest.getByRole('heading', { name: 'Join the queue' })).toBeVisible();
  await expect(guest.locator('html')).toHaveAttribute('lang', 'en');
  await context.close();
});

test('the status page shows the ticket before the language picker', async ({ browser }) => {
  const queue = await freshQueue();
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const guest = await context.newPage();
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Sam');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);

  const ticket = await guest.getByText('Your ticket', { exact: true }).boundingBox();
  const picker = await guest.getByLabel('Language').boundingBox();
  expect(ticket!.y).toBeLessThan(picker!.y);
  expect(ticket!.y).toBeLessThan(260);
  await expectNoSeriousA11yViolations(guest);
  await context.close();
});

import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// 4-PAY2 (#992): the page a staff tablet's QR opens. CI has no edge runtime and no Stripe account,
// so payment-intent is stubbed in the browser; the code rules (hashed, ten minutes, replaced on
// re-ask, one neutral answer, cross-tenant) are covered by pgTAP and the function's Deno tests.

test('a scanned pay code shows the amount and closes after the guest pays', async ({ devices }) => {
  const { guest } = devices;
  let sent: unknown;
  await guest.route('**/functions/v1/payment-intent', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        payment_id: 'pay-e2e',
        kind: 'pos',
        amount_minor: 1850,
        currency: 'usd',
        cancel_cutoff_hours: 24,
        release_after: 'served',
        client_secret: 'cs_test',
        publishable_key: '',
      }),
    });
  });
  await guest.goto('/pay/ABCD2345');
  await expect(guest.getByRole('heading', { name: 'Pay at the counter' })).toBeVisible();
  await expect(guest.getByText('$18.50', { exact: true })).toBeVisible();
  expect(sent).toEqual({ code: 'ABCD2345' });
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Close' }).click();
  await expect(guest.getByRole('status')).toContainText('payment went through');
});

test('an unknown, expired or paid code shows one neutral message', async ({ devices }) => {
  const { guest } = devices;
  await guest.route('**/functions/v1/payment-intent', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ error: 'not_found' }),
    }),
  );
  await guest.goto('/pay/ZZZZZZZZ');
  await expect(guest.getByRole('heading', { name: 'This payment link has ended' })).toBeVisible();
  await expect(guest.getByText(/ask the staff for a new code/i)).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
});

test('returning from 3-D Secure thanks the guest instead of saying the link ended', async ({
  devices,
}) => {
  const { guest } = devices;
  await guest.route('**/functions/v1/payment-intent', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ error: 'not_found' }),
    }),
  );
  await guest.goto('/pay/ABCD2345?redirect_status=succeeded');
  await expect(guest.getByRole('status')).toContainText('payment went through');
  await expect(guest.getByRole('heading', { name: 'This payment link has ended' })).toHaveCount(0);
});

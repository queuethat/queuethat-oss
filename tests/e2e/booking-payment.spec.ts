import { bookableLocation } from './support/booking.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// A-13 (#366): after booking a service with a payment policy the guest sees the amount and the
// cancellation policy, enters a card in Stripe's element and lands on their appointment. CI has no
// edge runtime and no Stripe account, so the payment-intent function and Stripe.js are stubbed in
// the browser; the policy-to-intent rules are covered by pgTAP and the function's Deno tests.
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

const STRIPE_STUB = `
window.Stripe = function () {
  return {
    elements: function () {
      return { create: function () { return {
        mount: function (el) { el.innerHTML = '<label>Card number <input name="card" /></label>'; },
        destroy: function () {},
      }; } };
    },
    confirmPayment: function () {
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(window.__stripeResult || {}); }, 50);
      });
    },
    confirmSetup: function () { return Promise.resolve({}); },
  };
};`;

async function bookWithPayment(
  guest: import('@playwright/test').Page,
  kind: 'hold' | 'deposit' = 'hold',
) {
  const { slug } = await bookableLocation('Europe/Berlin');
  await guest.route('**/functions/v1/payment-intent', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        payment_id: 'pay-e2e',
        kind,
        amount_minor: 2500,
        currency: 'usd',
        cancel_cutoff_hours: 24,
        release_after: 'served',
        client_secret: 'cs_test',
        publishable_key: 'pk_test_e2e',
      }),
    }),
  );
  await guest.route('https://js.stripe.com/v3/', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: STRIPE_STUB }),
  );
  await guest.goto(`/b/${slug}`);
  await guest.getByRole('list').first().getByRole('button').first().click();
  await guest
    .getByRole('button', { name: /^\d{1,2}:\d{2}/ })
    .first()
    .click();
  await guest.getByLabel('First name').fill('Dana');
  await guest.getByRole('button', { name: 'Confirm booking' }).click();
}

test('the guest sees the amount and policy, pays, and lands on the appointment', async ({
  devices,
}) => {
  const { guest } = devices;
  await bookWithPayment(guest);

  await expect(guest.getByRole('heading', { name: 'Secure your booking' })).toBeVisible();
  await expect(guest.getByText(/place a hold of \$25\.00/)).toBeVisible();
  await expect(guest.getByText(/Cancel at least 24 hours before/)).toBeVisible();
  await expect(guest.getByLabel('Card number')).toBeVisible();
  await expectNoSeriousA11yViolations(guest);

  await guest.getByRole('button', { name: 'Place hold of $25.00' }).click();
  await expect(guest).toHaveURL(/\/a\/[\w-]+$/);
  await expect(guest.getByTestId('appointment')).toBeVisible();
});

test('a declined card shows a message and keeps the guest on the step', async ({ devices }) => {
  const { guest } = devices;
  await guest.addInitScript(() => {
    (window as unknown as { __stripeResult: unknown }).__stripeResult = {
      error: { code: 'card_declined' },
    };
  });
  await bookWithPayment(guest);

  await guest.getByRole('button', { name: 'Place hold of $25.00' }).click();
  await expect(guest.getByRole('alert')).toContainText('declined');
  await expect(guest.getByRole('alert')).toBeFocused();
  await expectNoSeriousA11yViolations(guest);
  await expect(guest).not.toHaveURL(/\/a\//);
});

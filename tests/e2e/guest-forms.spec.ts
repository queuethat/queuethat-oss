import { bookableLocation } from './support/booking.ts';
import { attachForm } from './support/forms.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// F4 (#1280): a booking asks the service's form after the contact fields. The client collects and
// renders; the database says what is acceptable, naming the field it refused.
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

const FIELDS = [
  { key: 'about', label: 'About you', type: 'heading' },
  { key: 'reason', label: 'Reason for visit', type: 'long_text', required: true },
  { key: 'areas', label: 'Areas', type: 'multi_choice', options: ['Back', 'Neck', 'Legs'] },
  { key: 'first', label: 'First time here', type: 'yes_no' },
];

test('booking: the form shows after the details, a refused answer is fixed after booking', async ({
  devices,
}) => {
  const { guest } = devices;
  const place = await bookableLocation('Europe/Berlin');
  await attachForm(
    place.owner.email,
    {
      orgId: place.orgId,
      locationId: place.locationId,
      targetIds: [place.serviceId],
      channel: 'booking',
    },
    FIELDS,
  );
  const saved: unknown[] = [];
  guest.on('request', (request) => {
    if (request.url().endsWith('/rpc/set_booking_answers')) saved.push(request.postDataJSON());
  });

  await guest.goto(`/b/${place.slug}`);
  await guest.getByRole('list').first().getByRole('button').first().click();
  await guest
    .getByRole('button', { name: /^\d{1,2}:\d{2}/ })
    .first()
    .click();
  await guest.getByLabel('First name').fill('Dana');
  await expect(guest.getByRole('heading', { name: 'About you' })).toBeVisible();
  await guest.getByLabel('Neck').check();
  await expectNoSeriousA11yViolations(guest);

  // Leaving the required question empty does not stop the booking; the database refuses the answers.
  await guest.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(guest.getByRole('heading', { name: 'Your booking is confirmed' })).toBeVisible();
  await expect(guest.getByLabel(/Reason for visit/)).toBeFocused();
  await expect(guest.getByText('Please check this answer.')).toBeVisible();
  await expect(guest.getByLabel('Neck')).toBeChecked();
  await expectNoSeriousA11yViolations(guest);

  await guest.getByLabel(/Reason for visit/).fill('Stiff shoulder');
  await guest.getByRole('button', { name: 'Save answers' }).click();
  await expect(guest).toHaveURL(/\/a\/[\w-]+$/);
  expect((saved.at(-1) as { p_answers: unknown }).p_answers).toEqual({
    reason: 'Stiff shoulder',
    areas: ['Neck'],
  });
});

import { restAs } from './support/accounts.ts';
import { bookableLocation } from './support/booking.ts';
import { attachForm } from './support/forms.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// W3 (#1305): a form with an agreement and a typed signature. The guest ticks and types; the
// database stamps the evidence and refuses an unticked required agreement by key.
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

const FIELDS = [
  {
    key: 'terms',
    label: 'Studio waiver',
    type: 'agreement',
    required: true,
    body: 'I understand the risks.\n\n- No refunds\n- **Bring ID**',
  },
  {
    key: 'sig',
    label: 'Your full name',
    type: 'signature',
    required: true,
    collect_guardian: true,
  },
];

test('booking: an unticked waiver is refused, then accepted and signed', async ({ devices }) => {
  const { guest } = devices;
  const place = await bookableLocation('Europe/Berlin');
  const privacy = await restAs(place.owner.email, 'org_privacy', {
    method: 'POST',
    body: JSON.stringify({
      org_id: place.orgId,
      officer_name: 'Pat Privacy',
      email: 'privacy@example.test',
      jurisdiction: 'ca',
    }),
  });
  expect(privacy.ok).toBe(true);
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
  await expect(guest.getByRole('heading', { name: 'Studio waiver' })).toBeVisible();
  await expect(guest.getByText('Bring ID')).toBeVisible();
  await expect(guest.getByLabel(/I have read and agree/)).not.toBeChecked();
  await expect(guest.getByLabel(/Parent or guardian name/)).toBeVisible();
  await expectNoSeriousA11yViolations(guest);

  await guest.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(guest.getByRole('heading', { name: 'Your booking is confirmed' })).toBeVisible();
  await expect(guest.getByText('Please check this answer.').first()).toBeVisible();

  await guest.getByLabel(/I have read and agree/).check();
  await guest.getByLabel(/Your full name/).fill('Dana Ruiz');
  await guest.getByRole('button', { name: 'Save answers' }).click();
  await expect(guest).toHaveURL(/\/a\/[\w-]+$/);
  expect((saved.at(-1) as { p_answers: unknown }).p_answers).toEqual({
    terms: true,
    sig: { name: 'Dana Ruiz' },
  });
});

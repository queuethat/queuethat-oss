import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import {
  confirmedAccount,
  NEW_ACCOUNT_PASSWORD,
  ownerOfNewBusiness,
  readAs,
  signInTo,
} from './support/accounts.ts';
import type { Page } from '@playwright/test';

// ORG-14 (#93), T3 (#1297): a new owner answers "What kind of business is this?" or starts blank.
test.use({ staffUser: null });

/** Searches the catalog, checks the recommended pick and its guest preview, then uses it. */
async function useTemplate(page: Page, search: string, name: string) {
  await page.getByLabel('Search templates').fill(search);
  await expect(page.getByRole('radio', { name: `${name} (recommended)` })).toBeChecked();
  await expect(page.getByRole('region', { name: `Preview of ${name}` })).toBeVisible();
  await page.getByRole('button', { name: 'Use this' }).click();
}

async function toTemplateStep(staff: Page, businessName = `Templates ${Date.now()}`) {
  const email = await confirmedAccount();
  await staff.goto('/auth/sign-in?next=%2Fonboarding');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await staff.getByLabel('Business name').fill(businessName);
  await staff.getByRole('button', { name: 'Next' }).click();
  await staff.getByLabel('Location name').fill('Main Street');
  await staff.getByLabel('Time zone').fill('Europe/Berlin');
  await staff.getByRole('button', { name: 'Next' }).click();
  return email;
}

test('picking Barber creates its queue, services and chairs, then links to edit them', async ({
  devices,
}) => {
  const { staff } = devices;
  // The business name alone recommends Barber, with a preview of the guest's choices.
  const email = await toTemplateStep(staff, `Fade Barber ${Date.now()}`);
  await expect(staff.getByText('What kind of business is this?')).toBeVisible();
  await expect(staff.getByRole('radio', { name: 'Barber (recommended)' })).toBeChecked();
  const preview = staff.getByRole('region', { name: 'Preview of Barber' });
  await expect(preview).toContainText('Haircut, about 30 min');
  await expectNoSeriousA11yViolations(staff);
  await staff.getByRole('button', { name: 'Use this' }).click();
  await expect(staff.getByText('Based on Barber v2')).toBeVisible();
  await expect(staff.getByLabel('Queue name')).toHaveCount(0);
  await staff.getByRole('button', { name: 'Create my business' }).click();

  await expect(staff.getByText('Your line is live')).toBeVisible();
  await expect(staff.getByRole('status')).toHaveText(
    'Created 4 queues, 24 services and 3 counters.',
  );
  await expectNoSeriousA11yViolations(staff);
  const rows = await readAs(email, [
    'queues?select=name,kind&order=name',
    'services?select=name,expected_minutes&order=name',
    'counters?select=label&order=label',
  ]);
  // Every line carries the same six services; compare them once.
  const unique = (list: unknown) => [
    ...new Map((list as { name: string }[]).map((x) => [x.name, x])).values(),
  ];
  rows[1] = unique(rows[1]);
  expect(rows).toEqual([
    // Three barbers' own lines plus "Anyone available", each with the template's services (T4).
    [
      { name: 'Anyone available', kind: 'pool' },
      { name: 'Barber 1', kind: 'provider' },
      { name: 'Barber 2', kind: 'provider' },
      { name: 'Barber 3', kind: 'provider' },
    ],
    [
      { name: 'Beard trim', expected_minutes: 15 },
      { name: 'Haircut', expected_minutes: 30 },
      { name: 'Haircut and beard', expected_minutes: 45 },
      { name: 'Hot towel shave', expected_minutes: 30 },
      { name: "Kids' cut (under 12)", expected_minutes: 20 },
      { name: 'Skin fade', expected_minutes: 40 },
    ],
    [{ label: 'Chair 1' }, { label: 'Chair 2' }, { label: 'Chair 3' }],
  ]);
  await staff.getByRole('link', { name: 'Edit queues and services' }).click();
  await expect(staff).toHaveURL(/\/admin\/queues$/);
  // The copy remembers where it came from.
  await expect(staff.getByTestId('template-origin').first()).toHaveText('Based on Barber v2');
});

test('the clinic card explains that names are never shown, and the guardrail holds', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await toTemplateStep(staff);
  await staff.getByLabel('Search templates').fill('walk-in clinic');
  await expect(staff.getByRole('region', { name: 'Preview of Walk-in clinic' })).toContainText(
    'Names are never shown on screens',
  );
  await useTemplate(staff, 'walk-in clinic', 'Walk-in clinic');
  await staff.getByRole('button', { name: 'Create my business' }).click();
  await expect(staff.getByText('Your line is live')).toBeVisible();
  const [orgs] = await readAs(email, ['organizations?select=health_tagged']);
  expect(orgs).toEqual([{ health_tagged: true }]);
});

test('AC1 (data): picking Restaurant sets party size 1-12 on its queue', async ({ devices }) => {
  const { staff } = devices;
  const email = await toTemplateStep(staff);
  await useTemplate(staff, 'restaurant', 'Restaurant');
  await staff.getByRole('button', { name: 'Create my business' }).click();
  await expect(staff.getByText('Your line is live')).toBeVisible();
  const [queues] = await readAs(email, [
    'queues?select=name,party_size_enabled,party_size_min,party_size_max',
  ]);
  expect(queues).toEqual([
    { name: 'Waitlist', party_size_enabled: true, party_size_min: 1, party_size_max: 12 },
  ]);

  // The join page offers it, bounded 1-12.
  const [locations] = (await readAs(email, ['locations?select=slug'])) as [{ slug: string }[]];
  await devices.guest.goto(`/q/${locations[0]!.slug}`);
  await expect(devices.guest.getByText('How many people?')).toBeVisible();
  await expect(devices.guest.getByRole('button', { name: 'One fewer person' })).toBeVisible();
  const more = devices.guest.getByRole('button', { name: 'One more person' });
  for (let i = 0; i < 15; i++) if (await more.isEnabled()) await more.click();
  await expect(devices.guest.getByText('12', { exact: true })).toBeVisible();
});

test('AC2: Start blank behaves like the original wizard', async ({ devices }) => {
  const { staff } = devices;
  await toTemplateStep(staff);
  // Nothing is used until "Use this"; Enter in the search box never submits the step.
  await staff.getByLabel('Search templates').fill('nothing like this');
  await staff.getByLabel('Search templates').press('Enter');
  await expect(staff.getByText('No template matches. Try another word.')).toBeVisible();
  await expect(staff.getByLabel('Queue name')).toHaveValue('Walk-ins');
  await staff.getByRole('button', { name: 'Create my business' }).click();
  await expect(staff.getByText('Your line is live')).toBeVisible();
  await expect(staff.getByRole('link', { name: 'Edit queues and services' })).toHaveCount(0);
});

test('an owner applies a template from the location page while it has no visits', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/location');
  await staff.getByRole('button', { name: 'Apply a template' }).click();
  await useTemplate(staff, 'service counter', 'Service counter');
  await expect(staff.getByText('Template applied.')).toBeVisible();
  const [queues] = await readAs(email, ['queues?select=name']);
  expect(queues).toEqual([{ name: 'Counter service' }]);
});

import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import {
  confirmedAccount,
  NEW_ACCOUNT_PASSWORD,
  ownerOfNewBusiness,
  readAs,
  signInTo,
} from './support/accounts.ts';
import type { Page } from '@playwright/test';

// ORG-14 (#93): a new owner picks an industry template, or starts blank.
test.use({ staffUser: null });

async function toTemplateStep(staff: Page) {
  const email = await confirmedAccount();
  await staff.goto('/auth/sign-in?next=%2Fonboarding');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await staff.getByLabel('Business name').fill(`Templates ${Date.now()}`);
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
  const email = await toTemplateStep(staff);
  await expectNoSeriousA11yViolations(staff);
  await staff.getByRole('button', { name: /Barber or salon/ }).click();
  await expect(staff.getByLabel('Queue name')).toHaveCount(0);
  await staff.getByRole('button', { name: 'Create my business' }).click();

  await expect(staff.getByText('Your line is live')).toBeVisible();
  await expect(staff.getByRole('status')).toHaveText('Created 1 queue, 2 services and 3 counters.');
  await expectNoSeriousA11yViolations(staff);
  const rows = await readAs(email, [
    'queues?select=name',
    'services?select=name,expected_minutes&order=name',
    'counters?select=label&order=label',
  ]);
  expect(rows).toEqual([
    [{ name: 'Walk-ins' }],
    [
      { name: 'Beard', expected_minutes: 15 },
      { name: 'Haircut', expected_minutes: 30 },
    ],
    [{ label: 'Chair 1' }, { label: 'Chair 2' }, { label: 'Chair 3' }],
  ]);
  await staff.getByRole('link', { name: 'Edit queues and services' }).click();
  await expect(staff).toHaveURL(/\/admin\/queues$/);
});

test('the clinic card explains that names are never shown, and the guardrail holds', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await toTemplateStep(staff);
  const card = staff.getByRole('button', { name: /Clinic/ });
  await expect(card).toContainText('Names are never shown on screens');
  await card.click();
  await staff.getByRole('button', { name: 'Create my business' }).click();
  await expect(staff.getByText('Your line is live')).toBeVisible();
  const [orgs] = await readAs(email, ['organizations?select=health_tagged']);
  expect(orgs).toEqual([{ health_tagged: true }]);
});

test('AC1 (data): picking Restaurant sets party size 1-12 on its queue', async ({ devices }) => {
  const { staff } = devices;
  const email = await toTemplateStep(staff);
  await staff.getByRole('button', { name: /Restaurant/ }).click();
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
  await expect(staff.getByRole('button', { name: /Start blank/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
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
  await staff.getByRole('button', { name: /Service counter/ }).click();
  await staff.getByRole('button', { name: 'Apply template' }).click();
  await expect(staff.getByText('Template applied.')).toBeVisible();
  const [queues] = await readAs(email, ['queues?select=name']);
  expect(queues).toEqual([{ name: 'Counter service' }]);
});

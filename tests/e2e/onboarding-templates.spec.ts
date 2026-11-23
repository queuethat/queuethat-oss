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
async function useTemplate(page: Page, search: string, name: string, apply = false) {
  await page.getByLabel('Search templates').fill(search);
  await expect(page.getByRole('radio', { name: `${name} (recommended)` })).toBeChecked();
  await expect(page.getByRole('region', { name: `Preview of ${name}` })).toBeVisible();
  // The wizard has no "Use this"; the location page's dialog still does.
  if (apply) await page.getByRole('button', { name: 'Use this' }).click();
  else await expect(page.getByRole('button', { name: 'Use this' })).toHaveCount(0);
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
  // One button on the step; the blank queue form is collapsed.
  await expect(staff.getByRole('button', { name: 'Use this' })).toHaveCount(0);
  await expect(staff.getByLabel('Queue name')).toHaveCount(0);
  // One barber line to start, and a line with no name cannot be made.
  await expect(staff.getByLabel('Name of barber 1')).toHaveValue('');
  await staff.getByRole('button', { name: 'Create my business' }).click();
  await expect(staff.getByText('Your line is live')).toHaveCount(0);
  await staff.getByLabel('How many? (one line per barber)').fill('2');
  await staff.getByLabel('Name of barber 1').fill('Sam');
  await staff.getByLabel('Name of barber 2').fill('   ');
  await staff.getByRole('button', { name: 'Create my business' }).click();
  await expect(staff.getByText('Name every line before you continue.')).toBeVisible();
  await staff.getByLabel('Name of barber 2').fill('Alex');
  await staff.getByRole('button', { name: 'Create my business' }).click();

  await expect(staff.getByText('Your line is live')).toBeVisible();
  await expect(staff.getByRole('status').first()).toHaveText('2 barbers, 6 services');
  // The live screen and Today share one first-run list and its words.
  await expect(staff.getByRole('heading', { name: 'Get your line ready' })).toBeVisible();
  await expect(staff.getByText('Pair a screen', { exact: true }).first()).toBeVisible();
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
    // The two named barbers' lines plus "Anyone available"; no unnamed "Barber 3" (T4, #65).
    [
      { name: 'Alex', kind: 'provider' },
      { name: 'Anyone available', kind: 'pool' },
      { name: 'Sam', kind: 'provider' },
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
  // The copy remembers where it came from, without saying so on every card (#88).
  await expect(staff.getByTestId('queue').first()).toBeVisible();
  await expect(staff.getByTestId('template-origin')).toHaveCount(0);
  const [origins] = (await readAs(email, ['queues?select=origin_template,origin_version'])) as [
    { origin_template: string; origin_version: number }[],
  ];
  expect(origins).toContainEqual({ origin_template: 'barber', origin_version: 3 });
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
  // If the template has personal lines, each needs a name before anything is made.
  const lineName = staff.getByLabel(/^Name of .* 1$/);
  if (await lineName.count()) await lineName.fill('Dr. Lee');
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
  // Enter in the search box never submits the step; "Start blank" opens the hand-made queue.
  await staff.getByLabel('Search templates').fill('nothing like this');
  await staff.getByLabel('Search templates').press('Enter');
  await expect(staff.getByText('No template matches. Try another word.')).toBeVisible();
  await staff.getByRole('button', { name: 'Start blank instead' }).click();
  await expect(staff.getByLabel('Queue name')).toHaveValue('Walk-ins');
  await staff.getByRole('button', { name: 'Create my business' }).click();
  await expect(staff.getByText('Your line is live')).toBeVisible();
  await expect(staff.getByRole('link', { name: 'Edit queues and services' })).toHaveCount(0);
});

test('a reload mid-wizard keeps what was typed', async ({ devices }) => {
  const { staff } = devices;
  await toTemplateStep(staff, 'Reload Barber Shop');
  await staff.getByLabel('Name of barber 1').fill('Sam');
  await staff.reload();
  await expect(staff.getByLabel('Name of barber 1')).toHaveValue('Sam');
  await expect(staff.getByRole('radio', { name: 'Barber (recommended)' })).toBeChecked();
  await staff.getByRole('button', { name: 'Back' }).click();
  await expect(staff.getByLabel('Location name')).toHaveValue('Main Street');
  await staff.getByRole('button', { name: 'Back' }).click();
  await expect(staff.getByLabel('Business name')).toHaveValue('Reload Barber Shop');
});

test('an owner applies a template from the location page while it has no visits', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/location');
  await staff.getByRole('tab', { name: 'Advanced' }).click();
  await staff.getByRole('button', { name: 'Apply a template' }).click();
  await useTemplate(staff, 'service counter', 'Service counter', true);
  await expect(staff.getByText('Template applied.')).toBeVisible();
  const [queues] = await readAs(email, ['queues?select=name']);
  expect(queues).toEqual([{ name: 'Counter service' }]);
});

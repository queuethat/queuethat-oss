import { createClient } from '@supabase/supabase-js';
import { sha256Hex } from '../../packages/domain/src/consent.ts';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { operatorEnv, supabaseEnv } from './support/env.ts';
import { enableDemoSms } from './support/sms.ts';

// 3-CG6 (#331): the opt-in at join. The screenshot of the step is the 10DLC artifact.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

test.beforeEach(() => enableDemoSms(service));

function randomPhone() {
  const pick = 200 + Math.floor(Math.random() * 800);
  const exchange = pick % 100 === 11 ? pick + 1 : pick; // N11 exchanges aren't numbers
  const line = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  return { typed: `+1 415 ${exchange} ${line}`, e164: `+1415${exchange}${line}` };
}

async function consentsFor(e164: string) {
  const { data: contact } = await service
    .schema('app')
    .from('guest_contacts')
    .select('id')
    .eq('org_id', demo.orgId)
    .eq('value', e164)
    .maybeSingle();
  if (!contact) return [];
  const { data } = await service
    .schema('app')
    .from('consents')
    .select('source, purpose, consent_text_version, consent_text_hash')
    .eq('contact_id', contact.id);
  return data ?? [];
}

async function fillJoin(guest: import('@playwright/test').Page, name: string, typed: string) {
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(demo.queues.walkIns);
  await guest.getByLabel('What do you need?').selectOption(demo.services.beardTrim);
  await guest.getByLabel('First name').fill(name);
  await expect(guest.getByLabel('Country code')).toBeVisible(); // lazy chunk loaded
  await guest.getByLabel('Mobile number (optional)').fill(typed);
}

test('AC2: a ticked opt-in stores the version and hash of the text on screen', async ({
  devices,
}, testInfo) => {
  const { guest } = devices;
  const phone = randomPhone();
  await fillJoin(guest, 'Opt-in Olive', phone.typed);
  const box = guest
    .getByTestId('sms-consent')
    .or(guest.getByRole('checkbox', { name: /will text you only about this visit/ }));
  await expect(box).not.toBeChecked();
  const shown = (await guest.getByText(/will text you only about this visit/).innerText()).trim();
  // Twilio toll-free opt-in proof: frequency, rates, STOP/HELP and links to the Terms and Privacy.
  expect(shown).toContain('Msg frequency varies. Msg & data rates may apply. Reply STOP');
  const legal = guest.getByTestId('sms-legal');
  await expect(legal.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
    'href',
    operatorEnv.VITE_TERMS_URL,
  );
  await expect(legal.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
    'href',
    operatorEnv.VITE_PRIVACY_URL,
  );
  await box.check();
  await expectNoSeriousA11yViolations(guest); // AC4
  if (testInfo.project.name === 'iphone') {
    await guest.screenshot({ path: 'docs/compliance/optin-screenshots/join-sms-optin.png' });
  }
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\//);
  await expect
    .poll(async () => (await consentsFor(phone.e164)).length, { timeout: 10_000 })
    .toBe(1);
  const [row] = await consentsFor(phone.e164);
  expect(row?.consent_text_version).toBe('2');
  expect(row?.consent_text_hash).toBe(await sha256Hex(shown));
});

test('AC3: not ticking joins without a consent row, and the status page offers texts', async ({
  devices,
}) => {
  const { guest } = devices;
  const phone = randomPhone();
  await fillJoin(guest, 'Quiet Quentin', phone.typed);
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\//);
  expect(await consentsFor(phone.e164)).toHaveLength(0);
  const panel = guest.getByRole('region', { name: "Get a text when it's your turn" });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Turn on text alerts' }).isDisabled();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Turn on text alerts' }).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await consentsFor(phone.e164)).length).toBe(1);
});

test('the opt-in is on screen before any number is typed, unticked', async ({ devices }) => {
  const { guest } = devices;
  await guest.goto(`/q/${demo.locationSlug}`);
  await expect(guest.getByLabel('First name')).toBeVisible();
  const box = guest.getByRole('checkbox', { name: /will text you only/ });
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
});

test('ticked with no number: says what is missing and does not join', async ({ devices }) => {
  const { guest } = devices;
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('First name').fill('No Number Nora');
  await guest.getByRole('checkbox', { name: /will text you only/ }).check();
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest.getByText(/Add your mobile number to get texts/)).toBeVisible();
  await expect(guest).not.toHaveURL(/\/v\//);
  await guest.getByRole('checkbox', { name: /will text you only/ }).uncheck();
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\//);
});

test('texts switched off: a number is taken but no opt-in is offered', async ({ devices }) => {
  const { guest } = devices;
  await guest.route('**/rpc/get_location_public', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, sms_enabled: false } });
  });
  await fillJoin(guest, 'Quiet Quinn', randomPhone().typed);
  await expect(guest.getByLabel('Mobile number (optional)')).toHaveValue(/415/);
  await expect(guest.getByText(/will text you only about this visit/)).toHaveCount(0);
});

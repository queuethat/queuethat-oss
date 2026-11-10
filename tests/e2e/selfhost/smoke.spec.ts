import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

// The self-host smoke journey (2P-OPS7, #213), against a running deploy/selfhost stack:
// an owner onboards, a guest joins, staff calls them, the guest's page and the waiting-room TV
// follow. Every request goes through Caddy on one hostname, as in a real install.
// Env: SELFHOST_URL, SELFHOST_ANON_KEY, SELFHOST_SERVICE_ROLE_KEY (see playwright.selfhost.config.ts).
// SELFHOST_DEMO=1 runs the demo-mode checks instead (DEMO_MODE=true stack).

const url = process.env.SELFHOST_URL!;
const anonKey = process.env.SELFHOST_ANON_KEY!;
const serviceKey = process.env.SELFHOST_SERVICE_ROLE_KEY!;
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const LIVE_MS = 5_000;
const PASSWORD = 'a-long-smoke-password';

test.skip(process.env.SELFHOST_DEMO === '1', 'demo-mode stack: see demo.spec.ts');

async function confirmedOwner(): Promise<string> {
  const email = `owner-${randomUUID().slice(0, 8)}@smoke.test`;
  const admin = createClient(url, serviceKey, noSession);
  const { error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  return email;
}

async function signInUi(page: Page, email: string) {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

// 2P-OPS6 (#212): runs first, before the journey creates its own organization.
test('a clean install has no organizations and no demo banner', async ({ page }) => {
  const { count, error } = await createClient(url, serviceKey, noSession)
    .schema('app')
    .from('organizations')
    .select('id', { count: 'exact', head: true });
  if (error) throw error;
  expect(count).toBe(0);
  await page.goto('/auth/sign-in');
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByTestId('demo-banner')).toHaveCount(0);
});

test('a clean install starts with onboarding, then a guest is served end to end', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const email = await confirmedOwner();
  const staffContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const staff = await staffContext.newPage();
  const guest = await guestContext.newPage();
  const tv = await tvContext.newPage();
  const business = `Smoke Cafe ${Date.now()}`;

  await test.step('onboarding: a signed-in owner with no business is sent to the wizard', async () => {
    await signInUi(staff, email);
    await expect(staff).toHaveURL(/\/onboarding$/);
    await staff.getByLabel('Business name').fill(business);
    await staff.getByRole('button', { name: 'Next' }).click();
    await staff.getByLabel('Location name').fill('Main Street');
    await staff.getByLabel('Street address').fill('1 Main Street');
    await staff.getByLabel('Time zone').fill('Europe/Berlin');
    await staff.getByRole('button', { name: 'Next' }).click();
    await staff.getByRole('button', { name: 'Create my business' }).click();
    // The wizard ends on its own "line is live" screen (join link and QR), not on /admin.
    await expect(staff.getByText('Your line is live')).toBeVisible();
  });

  // The owner's own client reads what the wizard made and mints a TV pairing code.
  const owner = createClient(url, anonKey, noSession);
  const signedIn = await owner.auth.signInWithPassword({ email, password: PASSWORD });
  expect(signedIn.error).toBeNull();
  const { data: locations } = await owner.schema('app').from('locations').select('id, slug');
  const location = locations![0]!;
  const { data: pairing, error } = await owner.schema('api').rpc('create_pairing_code', {
    p_location_id: location.id,
    p_kind: 'display',
    p_name: 'Smoke TV',
  });
  expect(error).toBeNull();

  await test.step('the TV pairs through the gateway and shows Now serving', async () => {
    await tv.goto('/display');
    await tv.getByLabel('Pairing code').fill((pairing as { code: string }).code);
    await tv.getByRole('button', { name: 'Pair' }).click();
    await expect(tv.getByRole('heading', { name: 'Now serving' })).toBeVisible();
  });

  let ticket = '';
  await test.step('a guest joins from the poster page', async () => {
    await guest.goto(`/q/${location.slug}`);
    await guest.getByLabel('First name').fill('Sam');
    await guest.getByRole('button', { name: 'Join the queue' }).click();
    await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
    ticket = (await guest.getByTestId('ticket').textContent()) ?? '';
    expect(ticket).not.toBe('');
    await expect(guest.getByText("You're number 1 in line")).toBeVisible();
  });

  await test.step('staff call the guest; the status page and the TV follow within seconds', async () => {
    await staff.goto('/staff');
    await expect(staff.getByTestId('section-waiting')).toBeVisible();
    await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(1, {
      timeout: LIVE_MS,
    });
    await staff.getByRole('button', { name: 'Call next' }).click();
    await expect(guest.getByText(/^It's your turn\. Please go to .+\.$/)).toBeVisible({
      timeout: LIVE_MS,
    });
    await expect(tv.getByTestId('now-serving')).toContainText(ticket, { timeout: LIVE_MS });
  });
});

test('the sign-in page loads from the image with this install’s own API', async ({ page }) => {
  const config = await (await page.request.get('/config.js')).text();
  expect(config).toContain(`SUPABASE_URL: "${url.replace(/\/$/, '')}"`);
  expect(config).not.toContain('service_role');
  const health = await page.request.get('/functions/v1/health');
  expect(health.status()).toBe(200);
});

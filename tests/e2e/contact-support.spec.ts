import { createClient } from '@supabase/supabase-js';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';
import { signedInOperator } from './support/totp.ts';

// #1138: a signed-in owner contacts support from the app in two taps; the operator sees the request, with the
// business, role, page and version beside it, on the tenant page and can close it.
test.use({ staffUser: null });

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

test('submit a request as an owner, then see and close it in the platform console (axe)', async ({
  devices,
  browser,
}) => {
  test.slow();
  const { staff: owner } = devices;
  const { email, slug } = await ownerOfNewBusiness();
  void slug;
  const [[org]] = (await readAs(email, ['organizations?select=id,name'])) as [
    [{ id: string; name: string }],
  ];

  await signInTo(owner, email, '/admin');
  await owner.getByRole('button', { name: 'Contact support' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Contact support' });
  await expect(dialog).toBeVisible();
  await expectNoSeriousA11yViolations(owner);
  await dialog.getByLabel('Subject').fill('Blank screen on the console');
  await dialog
    .getByLabel('What happened?')
    .fill('The staff console shows nothing after I sign in.');
  await dialog.getByRole('button', { name: 'Send message' }).click();
  const sent = dialog.getByTestId('support-sent');
  await expect(sent).toContainText('Your reference is SR-');
  const reference = /SR-\d{6}/.exec((await sent.textContent())!)![0];

  // Two outbox rows: one to support, one confirmation to the owner; the message is not echoed back.
  const { data: mail, error } = await service
    .schema('app')
    .from('notifications')
    .select('template_key, vars')
    .eq('org_id', org.id)
    .in('template_key', ['support_request', 'support_confirmation']);
  expect(error).toBeNull();
  expect(mail?.map((n) => n.template_key).sort()).toEqual([
    'support_confirmation',
    'support_request',
  ]);
  const toSupport = mail!.find((n) => n.template_key === 'support_request')!.vars as Record<
    string,
    string
  >;
  expect(toSupport).toMatchObject({
    reference,
    subject: 'Blank screen on the console',
    role: 'owner',
  });
  expect(toSupport.route).toBe('/admin');
  expect(
    JSON.stringify(mail!.find((n) => n.template_key === 'support_confirmation')!.vars),
  ).not.toContain('nothing after I sign in');

  // The operator opens the tenant page.
  const context = await browser.newContext();
  const operator = await context.newPage();
  await signedInOperator(operator);
  await operator.goto(`/platform/orgs/${org.id}`);
  const card = operator.getByTestId(`support-request-${reference}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Blank screen on the console');
  await expect(card).toContainText('The staff console shows nothing after I sign in.');
  await expect(card).toContainText(email);
  await expect(card).toContainText('/admin');
  await expect(card).toContainText('Open');
  await expectNoSeriousA11yViolations(operator);

  await card.getByRole('button', { name: 'Close request' }).click();
  await expect(card).toContainText('Closed');
  await expect(card.getByRole('button', { name: 'Reopen' })).toBeVisible();
  await context.close();
});

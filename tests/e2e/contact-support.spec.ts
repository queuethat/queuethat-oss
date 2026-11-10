import { createClient } from '@supabase/supabase-js';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';

// A signed-in owner contacts support from the app in two taps; the request is stored with the
// business, role, page and version beside it, and two emails are queued.
test.use({ staffUser: null });

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

test('submit a request as an owner (axe)', async ({ devices }) => {
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
});

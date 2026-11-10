import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { DEMO_PASSWORD } from '../fixtures/demo.ts';
import { expect, test } from './fixtures.ts';
import { signInAs } from './support/auth.ts';
import { supabaseEnv } from './support/env.ts';
import { uniqueEmail } from './support/mail.ts';

// 2B-ORG2 (#266): an owner restricts a staff member to one location on the team page; that member
// then sees only that location. The page itself shipped with 2A-TM3; this proves the AC end to end.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, { auth: { persistSession: false } });
const suffix = randomUUID().slice(0, 6);
const ownerEmail = uniqueEmail('mlo');
const staffEmail = uniqueEmail('mls');
const staffName = `Restricted ${suffix}`;

test.beforeAll(async () => {
  const app = service.schema('app');
  const { data: org, error } = await app
    .from('organizations')
    .insert({ name: `ML ${suffix}` })
    .select('id')
    .single();
  if (error) throw error;
  for (const [email, role, name] of [
    [ownerEmail, 'owner', 'ML owner'],
    [staffEmail, 'staff', staffName],
  ] as const) {
    const { data: user, error: userError } = await service.auth.admin.createUser({
      email,
      password: DEMO_PASSWORD,
      email_confirm: true,
    });
    if (userError) throw userError;
    const { error: memberError } = await app
      .from('memberships')
      .insert({ org_id: org.id, user_id: user.user.id, role, display_name: name });
    if (memberError) throw memberError;
  }
  for (const name of ['Downtown', 'Uptown']) {
    const { error: locationError } = await app.from('locations').insert({
      org_id: org.id,
      name: `${name} ${suffix}`,
      slug: `${name}-${suffix}`.toLowerCase(),
      tz: 'UTC',
    });
    if (locationError) throw locationError;
  }
});

test('AC1: restricted to Downtown, the member sees only Downtown', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  await signInAs(owner, { email: ownerEmail, password: DEMO_PASSWORD });
  await owner.goto('/admin/team');
  await owner.getByRole('button', { name: `Edit ${staffName}` }).click();
  const dialog = owner.getByRole('dialog', { name: `Edit ${staffName}` });
  await dialog.getByText('Advanced').click();
  await dialog.getByLabel(`Downtown ${suffix}`).check();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);

  const member = await (await browser.newContext()).newPage();
  await signInAs(member, { email: staffEmail, password: DEMO_PASSWORD });
  await member.goto('/staff');
  await expect(member.getByTestId('current-location')).toContainText(`Downtown ${suffix}`);
  await expect(member.getByText(`Uptown ${suffix}`)).toHaveCount(0);
});

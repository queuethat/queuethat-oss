import { createClient } from '@supabase/supabase-js';
import { DEMO_PASSWORD, demo, demoUsers } from '../fixtures/demo.ts';
import { supabaseDeps } from '../../supabase/functions/invite-staff/deps.ts';
import { createInviteStaffHandler } from '../../supabase/functions/invite-staff/handler.ts';
import { expect, signIn, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { confirmedAccount } from './support/accounts.ts';
import { authEmailFor, authLinkFor, uniqueEmail } from './support/mail.ts';

// 2A-TM1 (#95): an owner invites by email, the invitee opens the mailed link and lands in /staff
// as a member. CI starts Supabase without the edge runtime, so the invite-staff function's own
// handler and Supabase wiring run here, called with the owner's real JWT.
test.use({ staffUser: null });

/** POST to invite-staff as `email`, the way the team page will. Returns the function's answer. */
async function inviteAs(email: string, invitee: string, role = 'staff') {
  const env = supabaseEnv();
  const owner = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const { data, error } = await owner.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
  if (error) throw error;
  const handle = createInviteStaffHandler({
    ...supabaseDeps(createClient, { ...env, siteUrl: 'http://localhost:5173' }),
  });
  const response = await handle(
    new Request('http://localhost/functions/v1/invite-staff', {
      method: 'POST',
      headers: { authorization: `Bearer ${data.session!.access_token}` },
      body: JSON.stringify({ org_id: demo.orgId, email: invitee, role, display_name: 'Casey' }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test('an invitee opens the emailed link and joins the team as staff', async ({ devices }) => {
  const { staff } = devices;
  const invitee = uniqueEmail('invitee');
  const since = new Date();

  const invited = await inviteAs(demoUsers.owner.email, invitee);
  expect(invited.status).toBe(200);
  expect((invited.body.invitation as { token: unknown }).token).toBeNull();

  await staff.goto(await authLinkFor(invitee, since));
  await expect(staff).toHaveURL(/\/staff$/);
  await expect(staff.getByRole('button', { name: 'Sign out' })).toBeVisible();

  const { serviceRoleKey, url } = supabaseEnv();
  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const { data } = await admin
    .schema('app')
    .from('memberships')
    .select('role, display_name, org_id')
    .eq('display_name', 'Casey')
    .eq('org_id', demo.orgId);
  expect(data?.some((m) => m.role === 'staff')).toBe(true);
});

test('a new invitee gets an email that names the business', async () => {
  const invitee = uniqueEmail('named');
  const since = new Date();
  expect((await inviteAs(demoUsers.owner.email, invitee)).status).toBe(200);
  const html = await authEmailFor(invitee, since);
  expect(html).toContain('invited to join Demo Barber on QueueThat');
  expect(html).toContain('Accept the invitation');
});

test('an existing user gets an invitation, not a sign-in code they never asked for', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  const since = new Date();
  expect((await inviteAs(demoUsers.owner.email, email)).status).toBe(200);
  const html = await authEmailFor(email, since);
  expect(html).toContain('join Demo Barber on QueueThat');
  expect(html).not.toContain('where you asked for it');
  expect(html).not.toMatch(/>\s*\d{8}\s*</);

  await staff.goto(await authLinkFor(email, since));
  await expect(staff).toHaveURL(/\/staff$/);
  // Accepting clears the invitation wording from the account, so a later sign-in email is normal.
  const next = new Date();
  await staff.getByRole('button', { name: 'Sign out' }).click();
  // Sign out navigates to the sign-in page itself; a second goto would race it (WebKit rejects it).
  await expect(staff).toHaveURL(/\/auth\/sign-in$/);
  await staff.getByLabel('Email').fill(email);
  await staff.getByRole('button', { name: 'Email me a sign-in link' }).click();
  expect(await authEmailFor(email, next)).toContain('where you asked for it');
});

test('an admin-level caller is refused an owner invitation by the database', async () => {
  // staff@demo.test is not an owner or admin: the function relays permission_denied.
  const refused = await inviteAs(demoUsers.staff.email, uniqueEmail('nope'), 'owner');
  expect(refused.status).toBe(403);
});

test('a signed-in user with the wrong email sees the invitation is not valid for them', async ({
  devices,
}) => {
  const { staff } = devices;
  // Signed in before the first navigation, so goto is not raced by a post-sign-in redirect.
  await signIn(staff, 'staff');
  await staff.goto('/auth/accept-invite?token=not-a-real-token');
  await expect(staff.getByRole('alert')).toContainText('not valid for the account');
});

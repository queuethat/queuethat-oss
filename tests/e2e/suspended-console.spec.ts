import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { expect, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';

// #601: a suspended business's staff are told why, and a refused action says so.
test.use({ staffUser: null });

const env = supabaseEnv();
const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ??
  'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres';
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function businessWithQueue() {
  const { email } = await ownerOfNewBusiness();
  const [[org], [location]] = (await readAs(email, [
    'organizations?select=id',
    'locations?select=id',
  ])) as [[{ id: string }], [{ id: string }]];
  const { data: queue, error } = await service
    .schema('app')
    .from('queues')
    .insert({ org_id: org.id, location_id: location.id, name: 'Walk-ins', ticket_prefix: 'A' })
    .select('id')
    .single();
  if (error) throw error;
  const { error: serviceError } = await service.schema('app').from('services').insert({
    org_id: org.id,
    location_id: location.id,
    queue_id: queue.id,
    name: 'Cut',
    expected_minutes: 15,
  });
  if (serviceError) throw serviceError;
  return { email, orgId: org.id };
}

test('staff of a suspended business see why, and Call next explains the refusal; another business sees nothing', async ({
  devices,
  browser,
}) => {
  test.slow();
  const { staff } = devices;
  const [a, b] = [await businessWithQueue(), await businessWithQueue()];

  await signInTo(staff, a.email, '/staff');
  await staff.getByRole('button', { name: 'Add guest' }).click();
  const dialog = staff.getByRole('dialog');
  await dialog.getByLabel('Name (optional)').fill('Waiting Wanda');
  await dialog.getByRole('button', { name: 'Add to the line' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(staff.getByTestId('suspended-banner')).toHaveCount(0);

  // The operator's suspend is covered in platform-actions; this is the state it leaves behind.
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`update app.organizations
      set status = 'suspended', suspended_reason = 'Abuse reports', suspended_at = now()
      where id = ${a.orgId}`;
  } finally {
    await sql.end();
  }

  await staff.reload();
  const banner = staff.getByTestId('suspended-banner');
  await expect(banner).toContainText('Abuse reports');
  await expect(banner).toContainText('Contact support');
  await staff.getByRole('button', { name: 'Call next' }).click();
  await expect(
    staff.getByText('This business is suspended, so the queue can’t change. Contact support.'),
  ).toBeVisible();

  // Cross-tenant: the other business's staff see no banner.
  const context = await browser.newContext();
  const other = await context.newPage();
  await signInTo(other, b.email, '/staff');
  await expect(other.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(other.getByTestId('suspended-banner')).toHaveCount(0);
  await context.close();
});

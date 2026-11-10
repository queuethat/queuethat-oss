import postgres from 'postgres';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { signedInOperator } from './support/totp.ts';

// #1133: /platform/audit searches the platform audit across tenants, pages with a cursor and
// exports the filtered range as a file.
test.use({ staffUser: null });

const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ??
  'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres';

test('an operator filters, pages through 120 entries and exports them (axe)', async ({
  devices,
}) => {
  const { staff } = devices;
  // The audit is append-only, so each run uses an org id of its own. Entry 1 is inserted last, so
  // it has the highest id and comes first (the page orders by id, newest first).
  const org = crypto.randomUUID();
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1 });
  try {
    await sql`
      insert into app.platform_audit (action, org_id, target, reason, at)
      select 'zt.paging', ${org}::uuid, '{}'::jsonb, 'Entry ' || n,
             now() - make_interval(secs => n)
      from generate_series(120, 1, -1) n`;
  } finally {
    await sql.end();
  }

  await signedInOperator(staff);
  await staff.getByRole('link', { name: 'Audit log' }).click();
  await expect(staff.getByRole('heading', { name: 'Audit log' })).toBeVisible();

  await staff.getByLabel('Business ID').fill(org);
  await staff.getByRole('button', { name: 'Search' }).click();
  const rows = staff.getByTestId('audit-row');
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText(/Entry 1(?!\d)/);
  await expectNoSeriousA11yViolations(staff);

  await staff.getByRole('link', { name: 'Next 50' }).click();
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText(/Entry 51(?!\d)/);
  await staff.getByRole('link', { name: 'Next 50' }).click();
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText(/Entry 101(?!\d)/);
  await expect(staff.getByRole('link', { name: 'Next 50' })).toHaveCount(0);

  await staff.getByRole('link', { name: 'Previous page' }).click();
  await expect(rows.first()).toContainText(/Entry 51(?!\d)/);
  await staff.getByRole('link', { name: 'Back to the first page' }).click();
  await expect(rows.first()).toContainText(/Entry 1(?!\d)/);

  const download = staff.waitForEvent('download');
  await staff.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toBe('platform-audit-start-now.csv');
  await expect(staff.getByText('Exported 120 entries.')).toBeVisible();

  // The export is itself in the log.
  await staff.getByLabel('Action').fill('audit.export');
  await staff.getByLabel('Business ID').fill(org);
  await staff.getByRole('button', { name: 'Search' }).click();
  await expect(rows).toHaveCount(1);

  await staff.getByLabel('Action').fill('nothing.here');
  await staff.getByRole('button', { name: 'Search' }).click();
  await expect(staff.getByText('No audit entries match.')).toBeVisible();
});

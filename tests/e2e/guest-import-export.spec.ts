import { readFileSync } from 'node:fs';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// 2B-C6 (#305): admins export guests and import a CSV with column mapping and a preview.

test.describe('as owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC1: 2,500 rows import in three batches and the results file lists every row', async ({
    devices,
  }) => {
    const { staff } = devices;
    const tag = crypto.randomUUID().slice(0, 8);
    const lines = ['Full name,E-mail,Tags'];
    for (let i = 0; i < 2500; i++) lines.push(`Import ${i},imp-${tag}-${i}@example.com,bulk`);
    lines.push('No contact,,');

    await staff.goto('/admin/guests/import');
    await expect(staff.getByRole('heading', { name: 'Import and export guests' })).toBeVisible();
    await expect(staff.getByText('The file contains personal data')).toBeVisible();
    await staff.getByLabel('CSV file').setInputFiles({
      name: 'guests.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(lines.join('\n')),
    });
    await expect(staff.getByLabel('Name', { exact: true })).toHaveValue('0');
    await expect(staff.getByTestId('import-summary')).toContainText('2501 rows');
    await expect(staff.getByTestId('import-summary')).toContainText('1 row will be skipped');
    await expectNoSeriousA11yViolations(staff);

    const batches: number[] = [];
    staff.on('request', (req) => {
      if (req.url().includes('/rpc/import_guests')) {
        batches.push((req.postDataJSON() as { p_rows: unknown[] }).p_rows.length);
      }
    });
    await staff.getByRole('button', { name: 'Import 2500 rows' }).click();
    await expect(staff.getByTestId('import-progress')).toContainText('2501 of 2501', {
      timeout: 120_000,
    });
    expect(batches).toEqual([1000, 1000, 501]);
    await expect(staff.getByTestId('import-results')).toContainText('2500 created');

    const download = staff.waitForEvent('download');
    await staff.getByRole('button', { name: 'Download results (CSV)' }).click();
    const csv = readFileSync((await (await download).path()) as string, 'utf8');
    expect(csv.split('\r\n').length).toBe(2501 + 2); // header, 2501 rows, trailing newline
    expect(csv).toContain('2502,invalid,no_contact');
  });

  test('export downloads a CSV', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/admin/guests/import');
    const download = staff.waitForEvent('download');
    await staff.getByRole('button', { name: 'Export guests (CSV)' }).click();
    expect((await download).suggestedFilename()).toBe('guests.csv');
  });
});

test.describe('as staff', () => {
  test.use({ staffUser: 'staff' });

  test('AC2: staff see no import or export', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/admin/guests');
    await expect(staff.getByRole('heading', { name: 'Guests' })).toBeVisible();
    await expect(staff.getByRole('link', { name: 'Import or export guests' })).toHaveCount(0);
    await staff.goto('/admin/guests/import');
    await expect(staff.getByRole('alert')).toContainText('Only owners and admins');
    await expect(staff.getByRole('button', { name: 'Export guests (CSV)' })).toHaveCount(0);
  });
});

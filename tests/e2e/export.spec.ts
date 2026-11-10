import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, signInTo } from './support/accounts.ts';

// 2P-RPT5 (#201): owners and admins download the organization export.
test.describe('as an owner', () => {
  // A business of its own: the limit is 3 exports a day per organization, and every project runs this.
  test.use({ staffUser: null });

  test('AC1: Export downloads a zip and the remaining count shows', async ({ devices }) => {
    const { staff } = devices;
    // The Edge Function is not served by the local stack in e2e. Its handler is covered by
    // export-data/handler.test.ts; here the page, the real RPC and the download are under test.
    await staff.route('**/functions/v1/export-data', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/zip',
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Disposition',
          'Content-Disposition': 'attachment; filename="export-2026-10-30.zip"',
        },
        body: Buffer.from('PK'),
      }),
    );
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/export');
    await expect(staff.getByRole('heading', { name: 'Export data' })).toBeVisible();
    await expect(staff.getByTestId('export-remaining')).toContainText('Up to 3 exports a day');
    await expectNoSeriousA11yViolations(staff);

    const download = staff.waitForEvent('download');
    await staff.getByRole('button', { name: 'Export', exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('export-2026-10-30.zip');
    await expect(staff.getByTestId('export-remaining')).toContainText(/[0-2] left today/);
    await expect(staff.getByText('Your download has started.')).toBeVisible();
  });
});

test('AC2: staff cannot use the page', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/export');
  await expect(staff.getByText('Only owners and admins can export data.')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0);
});

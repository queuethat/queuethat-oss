import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, signInTo } from './support/accounts.ts';

// 4-SIG1 (#389): admins manage the slides a location's TV rotates.
test.use({ staffUser: null });

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');

test('AC2: an admin adds a text slide and an image, reorders and removes; an SVG is refused', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/signage');
  await expect(staff.getByRole('heading', { name: 'Signage', level: 1 })).toBeVisible();

  await staff.getByLabel('Text slide').fill('Free coffee today');
  await staff.getByRole('button', { name: 'Add text slide' }).click();
  await expect(staff.getByTestId('slide-preview').getByText('Free coffee today')).toBeVisible();

  // SVG is refused by type before any upload (and by the bucket's allowlist behind that).
  await staff
    .getByLabel('Image slide (PNG, JPEG or WebP)')
    .setInputFiles({ name: 'x.svg', mimeType: 'image/svg+xml', buffer: SVG });
  await expect(staff.getByRole('alert')).toContainText("SVG files aren't accepted");

  // A real image: drawn in the browser, so no fixture is checked in.
  const png = Buffer.from(
    await staff.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
      const blob: Blob = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/png'),
      );
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }),
  );
  await staff
    .getByLabel('Image slide (PNG, JPEG or WebP)')
    .setInputFiles({ name: 'promo.png', mimeType: 'image/png', buffer: png });
  await expect(staff.getByTestId('slide-preview')).toHaveCount(2, { timeout: 30_000 });
  await expect(staff.getByRole('img', { name: 'Slide image' })).toBeVisible();

  // Move the image slide up: it becomes the first row.
  await staff.getByRole('button', { name: 'Move up' }).nth(1).click();
  await expect(staff.getByTestId('slide-preview').first().getByRole('img')).toBeVisible();

  await expectNoSeriousA11yViolations(staff);

  await staff.getByRole('button', { name: 'Remove slide' }).first().click();
  await staff.getByRole('dialog').getByRole('button', { name: 'Remove slide' }).click();
  await expect(staff.getByTestId('slide-preview')).toHaveCount(1);
});

import type { Page } from '@playwright/test';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';

// 2P-BRD2 (#203): owners brand their guest pages.
test.use({ staffUser: null });

/** A noisy JPEG well over 5 MB, drawn in the browser so no fixture is checked in. */
async function bigJpeg(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2600;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(2600, 2600);
    for (let i = 0; i < image.data.length; i += 1)
      image.data[i] = i % 4 === 3 ? 255 : Math.random() * 256;
    context.putImageData(image, 0, 0);
    const blob: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.98),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
  return Buffer.from(base64, 'base64');
}

test('AC1, AC3: a 5 MB JPEG is re-encoded under 2 MB and uploaded; an SVG is refused', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/branding');
  await expect(staff.getByRole('heading', { name: 'Branding' })).toBeVisible();

  const jpeg = await bigJpeg(staff);
  expect(jpeg.length).toBeGreaterThan(5_000_000);
  await staff
    .getByLabel('Logo (PNG, JPEG or WebP)')
    .setInputFiles({ name: 'logo.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  const preview = staff.getByTestId('logo-preview');
  await expect(preview).toBeVisible({ timeout: 30_000 });
  const stored = await fetch((await preview.getAttribute('src'))!);
  expect(stored.ok).toBe(true);
  expect(Number(stored.headers.get('content-length'))).toBeLessThan(2_000_000);
  expect(stored.headers.get('content-type')).toMatch(/image\/(webp|jpeg)/);

  await staff.getByLabel('Cover image (PNG, JPEG or WebP)').setInputFiles({
    name: 'cover.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await expect(staff.getByRole('alert')).toContainText("SVG files aren't accepted");
  await expect(staff.getByTestId('cover-preview')).toHaveCount(0);
});

test('AC2: a low-contrast colour warns; branding saves and guests can read it', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email, slug } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/branding');
  await staff.getByLabel('Brand colour').fill('#959595');
  await expect(staff.getByTestId('colour-warning')).toContainText(
    'guest pages will use black text',
  );
  await staff.getByLabel('Welcome text (plain text)').fill('Welcome <b>in</b>');
  await staff.getByLabel('Terms link (optional)').fill('http://example.com/terms');
  await expect(staff.getByText('Use a link that starts with https://')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Save branding' })).toBeDisabled();
  await staff.getByLabel('Terms link (optional)').fill('https://example.com/terms');
  await expectNoSeriousA11yViolations(staff);
  await staff.getByRole('button', { name: 'Save branding' }).click();
  await expect(staff.getByText('Branding saved.')).toBeVisible();

  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/rest/v1/rpc/get_location_branding`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-profile': 'api', 'content-type': 'application/json' },
    body: JSON.stringify({ p_slug: slug }),
  });
  expect(await response.json()).toMatchObject({
    brand_primary: '#959595',
    welcome_text: 'Welcome <b>in</b>',
    terms_url: 'https://example.com/terms',
  });
});

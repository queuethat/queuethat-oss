import jsQR from 'jsqr';
import type { Page } from '@playwright/test';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, signInTo } from './support/accounts.ts';

// G7 (#57): a printable poster whose QR code opens the location's join page.

/** Draws the poster's QR code on a canvas and decodes it the way a phone camera would. */
async function scanPoster(page: Page): Promise<string | undefined> {
  const { width, pixels } = await page
    .getByTestId('poster')
    .locator('svg')
    .evaluate(async (svg) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 400;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0, 400, 400);
      return { width: 400, pixels: Array.from(context.getImageData(0, 0, 400, 400).data) };
    });
  return jsQR(Uint8ClampedArray.from(pixels), width, width)?.data;
}

test('AC1: the poster code opens the join page', async ({ devices }) => {
  const { staff, guest } = devices;
  await staff.goto('/admin/location');
  await staff.getByRole('link', { name: 'Print a QR poster' }).click();
  const poster = staff.getByTestId('poster');
  await expect(poster).toContainText('Demo Barber Main Street');
  await expect(poster).toContainText('Scan to join the line');
  const joinUrl = new URL(`/q/${demo.locationSlug}`, staff.url()).href;
  await expect(poster).toContainText(joinUrl);
  await expectNoSeriousA11yViolations(staff);

  const scanned = await scanPoster(staff);
  expect(scanned).toBe(joinUrl);
  await guest.goto(scanned!);
  await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeVisible();
});

test('printing shows only the poster, sized to fit A4 and Letter', async ({
  devices,
  browserName,
}) => {
  const { staff } = devices;
  await staff.goto('/admin/poster');
  await expect(staff.getByRole('button', { name: 'Print poster' })).toBeVisible();
  await staff.emulateMedia({ media: 'print' });
  await expect(staff.getByRole('button', { name: 'Print poster' })).toBeHidden();
  await expect(staff.getByRole('button', { name: 'Sign out' })).toBeHidden();
  // 249 mm is Letter's printable height inside the 15 mm margins, the smaller of the two papers.
  const box = (await staff.getByTestId('poster').boundingBox())!;
  const mm = 96 / 25.4;
  expect(box.height).toBeLessThanOrEqual(249 * mm + 1);
  expect(box.width).toBeLessThanOrEqual(staff.viewportSize()!.width);

  // Only Chromium prints to PDF: the poster is one page on either paper.
  if (browserName !== 'chromium') return;
  for (const format of ['A4', 'Letter']) {
    const pdf = (await staff.pdf({ format })).toString('latin1');
    expect(pdf.match(/\/Type\s*\/Page[^s]/g), format).toHaveLength(1);
  }
});

test.describe('as the owner of another business', () => {
  test.use({ staffUser: null });

  test("the poster points at the owner's own location, not the demo's", async ({ devices }) => {
    const { staff } = devices;
    const { email, slug } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/poster');
    await expect(staff.getByTestId('poster')).toContainText(`/q/${slug}`);
    expect(await scanPoster(staff)).toBe(new URL(`/q/${slug}`, staff.url()).href);
    await expect(staff.getByTestId('poster')).not.toContainText(demo.locationSlug);
  });
});

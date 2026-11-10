import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, restAs } from './support/accounts.ts';

// 2P-BRD3 (#204): guest pages wear the business's branding.
test.use({ staffUser: null });

test('AC1, AC2: the join page shows logo, colour, welcome text and legal links, and stays accessible', async ({
  devices,
}) => {
  const { guest } = devices;
  const { email, slug } = await ownerOfNewBusiness();
  const [location] = (await (
    await restAs(email, `locations?slug=eq.${slug}&select=id,org_id`)
  ).json()) as {
    id: string;
    org_id: string;
  }[];
  const orgId = location!.org_id;
  const logoPath = `org/${orgId}/branding/logo-e2e.webp`;
  expect(
    (
      await restAs(email, `organizations?id=eq.${orgId}`, {
        method: 'PATCH',
        body: JSON.stringify({ brand_primary: '#0b3d91', logo_path: logoPath }),
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await restAs(email, `locations?id=eq.${location!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          welcome_text: '<script>window.__xss = 1</script>Welcome in',
          terms_url: 'https://example.com/terms',
          privacy_url: 'https://example.com/privacy',
        }),
      })
    ).ok,
  ).toBe(true);

  await guest.goto(`/q/${slug}`);
  const branded = guest.getByTestId('branded');
  await expect(branded).toBeVisible();
  await expect(guest.getByText('<script>window.__xss = 1</script>Welcome in')).toBeVisible();
  expect(
    await guest.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();
  await expect(branded.locator('img')).toHaveAttribute('width', '40');
  expect(
    await guest.evaluate(() => document.documentElement.style.getPropertyValue('--color-primary')),
  ).toBe('#0b3d91');
  await expect(guest.getByRole('link', { name: 'Terms' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await expect(guest.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute(
    'href',
    'https://example.com/privacy',
  );
  await expectNoSeriousA11yViolations(guest);
});

test('a business without branding keeps the default page', async ({ devices }) => {
  const { guest } = devices;
  const { slug } = await ownerOfNewBusiness();
  await guest.goto(`/q/${slug}`);
  await expect(guest.getByRole('heading').first()).toBeVisible();
  await expect(guest.getByTestId('branded')).toHaveCount(0);
});

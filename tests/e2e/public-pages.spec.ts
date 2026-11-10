import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// #1086: the app root and the sign-up legal links. The legal text itself lives on queuethat.com. No sign-in, no data.
test.use({ staffUser: null });

test('the app root is the sign-in page, not a marketing page', async ({ devices }) => {
  const { guest } = devices;
  await guest.goto('/');
  await expect(guest).toHaveURL(/\/auth\/sign-in/);
  await expect(guest.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
});

test('sign-up links the Terms and Privacy Policy next to the submit button', async ({
  devices,
}) => {
  const { guest } = devices;
  await guest.goto('/auth/sign-up');
  const consent = guest.getByTestId('signup-consent');
  await expect(consent.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
    'href',
    'https://queuethat.com/terms',
  );
  await expect(consent.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
    'href',
    'https://queuethat.com/privacy',
  );
});

// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { demo } from '../../../tests/fixtures/demo.ts';
import { expect, test } from '../../../tests/e2e/fixtures.ts';

// J-7 (#246): the Google Business Profile page shows the join link with src=gbp. The page moved
// to ee/ (#108); the guest side of ?src=gbp stays covered by tests/e2e/attribution.spec.ts.

test('AC3: the admin page shows the link with src=gbp, also at its old address', async ({
  devices,
}) => {
  const { staff } = devices;
  await staff.goto('/admin/google');
  await expect(staff.getByTestId('gbp-link')).toHaveText(
    new RegExp(`/q/${demo.locationSlug}\\?src=gbp$`),
  );
  await expect(staff).toHaveURL(/\/admin\/x\/google$/);
});

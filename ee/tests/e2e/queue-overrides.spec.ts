// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { expect, expectNoSeriousA11yViolations, test } from '../../../tests/e2e/fixtures.ts';
import {
  ownerOfNewBusiness,
  readAs,
  restAs,
  signInTo,
} from '../../../tests/e2e/support/accounts.ts';

// 2B-Q13 (#238): per-queue message overrides. That the dispatcher then uses the queue
// wording is pinned in supabase/tests/notifications/template_resolution.test.sql (resolve_template).

test.use({ staffUser: null });

async function twoQueues(email: string) {
  const [[loc]] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  const make = (name: string, prefix: string) =>
    restAs(email, 'queues', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({
        org_id: loc!.org_id,
        location_id: loc!.id,
        name,
        ticket_prefix: prefix,
      }),
    }).then(async (r) => ((await r.json()) as { id: string }[])[0]!.id);
  return { repairs: await make('Repairs', 'R'), pickups: await make('Pickups', 'P') };
}

test('AC1: an override on one queue is saved for that queue only, and Revert returns it to the org wording', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  const { repairs, pickups } = await twoQueues(email);
  await signInTo(staff, email, `/admin/queues/${repairs}/messages`);
  await expect(staff.getByRole('heading', { name: 'Messages and look: Repairs' })).toBeVisible();

  const row = staff.getByRole('listitem').filter({ hasText: "It's your turn · SMS" });
  await expect(row).toContainText('Uses org default');
  await row.getByRole('button', { name: "Edit It's your turn, SMS" }).click();
  await staff.getByLabel('Message').fill('Repairs: {{ticket}}, come to the bench.');
  await staff.getByRole('button', { name: 'Save template' }).click();
  await expect(row).toContainText('Overridden');

  await staff.goto(`/admin/queues/${pickups}/messages`);
  await expect(
    staff.getByRole('listitem').filter({ hasText: "It's your turn · SMS" }),
  ).toContainText('Uses org default');

  await staff.goto(`/admin/queues/${repairs}/messages`);
  const again = staff.getByRole('listitem').filter({ hasText: "It's your turn · SMS" });
  await again.getByRole('button', { name: "Edit It's your turn, SMS" }).click();
  await staff.getByRole('button', { name: 'Revert to default' }).click();
  await staff.getByRole('dialog').getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(again).toContainText('Uses org default');
  await expectNoSeriousA11yViolations(staff);
});

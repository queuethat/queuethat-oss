import { expect, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';

// 2B-Q13 (#238): a queue's look. Its message overrides are in ee/tests/e2e/queue-overrides.spec.ts. That the dispatcher then uses the queue
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

test('AC2: an accent that fails 4.5:1 is blocked with an explanation; a good one saves', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  const { repairs } = await twoQueues(email);
  await signInTo(staff, email, `/admin/queues/${repairs}/messages`);

  await staff.getByLabel('Accent colour').fill('#ffee88');
  await staff.getByRole('button', { name: 'Save look' }).click();
  await expect(staff.getByText(/too light to read on a white page/)).toBeVisible();

  await staff.getByLabel('Accent colour').fill('#0b5cad');
  await staff.getByLabel('Welcome text').fill('Bring your ticket to the bench.');
  await staff.getByRole('button', { name: 'Save look' }).click();
  await expect(staff.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  const [rows] = (await readAs(email, [
    `queues?id=eq.${repairs}&select=brand_accent,welcome_text`,
  ])) as [{ brand_accent: string; welcome_text: string }[]];
  expect(rows[0]).toEqual({
    brand_accent: '#0b5cad',
    welcome_text: 'Bring your ticket to the bench.',
  });
});

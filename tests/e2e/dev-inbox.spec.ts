import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';

// 2P-NTF11 (#183): /dev/inbox shows what the console SMS channel "sent", per number, and updates by itself.
// Bundle absence (AC1) is apps/web/scripts/dev-inbox-bundle.test.mjs plus the last step of `pnpm build`.
// The dispatcher is not running here, so the SMS is written to dev_inbox the way its console channel does.

const { url, serviceRoleKey } = supabaseEnv();

async function sendSms(orgId: string, recipient: string, body: string, segments: number) {
  const response = await fetch(`${url}/rest/v1/dev_inbox`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
      'content-profile': 'app',
    },
    body: JSON.stringify({
      org_id: orgId,
      channel: 'sms',
      recipient,
      body,
      segments,
      encoding: 'gsm7',
    }),
  });
  if (!response.ok)
    throw new Error(`dev_inbox insert: ${response.status} ${await response.text()}`);
}

test.use({ staffUser: null });

test("a sent SMS appears in its number's thread within 5 s, with its segment count (AC2)", async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  const [orgs] = (await readAs(email, ['organizations?select=id'])) as [{ id: string }[]];
  await signInTo(staff, email, '/dev/inbox');
  await expect(staff.getByRole('heading', { name: 'Dev SMS inbox' })).toBeVisible();
  await expect(staff.getByText(/No messages yet/)).toBeVisible();

  await sendSms(orgs[0]!.id, '+14155550142', "It's your turn: A001. Please go to Chair 1.", 1);

  const thread = staff.getByRole('region', { name: 'Conversation with +14155550142' });
  await expect(thread.getByText("It's your turn: A001. Please go to Chair 1.")).toBeVisible({
    timeout: 5_000,
  });
  await expect(thread.getByText('1 segment')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});

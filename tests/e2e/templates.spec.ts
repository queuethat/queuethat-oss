import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { createClient } from '@supabase/supabase-js';
import { ownerOfNewBusiness, readAs, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';

const { url, serviceRoleKey } = supabaseEnv();
const service = createClient(url, serviceRoleKey, { auth: { persistSession: false } }).schema(
  'app',
);

// 2P-NTF7 (#179): owners reword notification templates with a live preview and segment count.
// S2 (#1219): the SMS preview is the database's framed text, per guest language.

test('AC3: staff see the templates but cannot change them', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/templates');
  await expect(staff.getByRole('heading', { name: 'Message templates' })).toBeVisible();
  await expect(
    staff.getByText('Only managers, admins and owners can change templates.'),
  ).toBeVisible();
  await staff.getByRole('button', { name: "View It's your turn, Push" }).click();
  await expect(staff.getByLabel('Message')).toBeDisabled();
  await expect(staff.getByRole('button', { name: 'Save template' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);
});

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test('AC1, AC2: preview and segments follow each keystroke; revert removes the override', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/templates');
    const rows = () =>
      readAs(email, [
        'notification_templates?select=trigger,channel,body,version&org_id=not.is.null',
      ]).then(([r]) => r as { trigger: string; channel: string; body: string; version: number }[]);

    await staff.getByRole('button', { name: "Edit It's your turn, SMS" }).click();
    const body = staff.getByLabel('Message');
    // S2 (#1219): the database composes the preview, frame included; sample name Alexandria, ticket A-123.
    await body.fill('Hi {{guest_first_name}}, ');
    await expect(staff.getByTestId('preview')).toContainText('Hi Alexandria,');
    await expect(staff.getByTestId('frame-footer')).toHaveText(
      'Reply STOP to opt out, HELP for help.',
    );
    await expect(staff.getByTestId('frame-prefix')).toHaveText(/: $/);
    await staff.getByRole('button', { name: 'Insert ticket' }).click();
    await expect(staff.getByTestId('preview')).toContainText('Hi Alexandria, A-123');
    await expect(staff.getByTestId('segments')).toContainText('1 text segment');
    await body.fill(`${'x'.repeat(161)}`);
    await expect(staff.getByTestId('segments')).toContainText('2 text segments');
    await body.fill('Hi {{guest_first_name}}, {{ticket}} is up!');
    await expectNoSeriousA11yViolations(staff);

    await body.fill('Big sale today');
    await staff.getByRole('button', { name: 'Save template' }).click();
    await expect(staff.getByRole('alert')).toContainText('“sale”');
    expect(await rows()).toEqual([]);

    await body.fill('Hello {{nope}}');
    await staff.getByRole('button', { name: 'Save template' }).click();
    await expect(staff.getByRole('alert')).toHaveText(
      "nope isn't a variable this message can use.",
    );
    expect(await rows()).toEqual([]);

    await body.fill('Hi {{guest_first_name}}, {{ticket}} is up!');
    await staff.getByRole('button', { name: 'Save template' }).click();
    await expect(staff.getByText('Custom', { exact: true })).toBeVisible();
    expect(await rows()).toEqual([
      {
        trigger: 'called',
        channel: 'sms',
        body: 'Hi {{guest_first_name}}, {{ticket}} is up!',
        version: 1,
      },
    ]);

    // Spanish guests get the English override until there is a Spanish one, and the editor says so.
    await staff.getByRole('tab', { name: 'Spanish' }).click();
    await staff.getByRole('button', { name: "Edit It's your turn, SMS" }).click();
    await expect(staff.getByTestId('other-locale')).toBeVisible();
    await expect(staff.getByTestId('frame-footer')).toHaveText(
      'Responde STOP para cancelar, HELP para ayuda.',
    );
    await staff.getByRole('tab', { name: 'English' }).click();

    await staff.getByRole('button', { name: "Edit It's your turn, SMS" }).click();
    await staff.getByRole('button', { name: 'Revert to default' }).click();
    await staff.getByRole('button', { name: 'Revert', exact: true }).click();
    await expect(staff.getByText('Custom', { exact: true })).toHaveCount(0);
    expect(await rows()).toEqual([]);
  });

  test('S2b: confirm my phone with a texted code, then text myself the saved message', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/templates');
    // One number per run: every project's new business saves its own row.
    const phone = `+1415555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
    await staff.getByRole('button', { name: "Edit It's your turn, SMS" }).click();
    await staff.getByLabel('Your mobile number').fill(phone);
    await staff.getByRole('button', { name: 'Text me a code' }).click();
    // The code text is in the outbox (nothing is sent locally); read it as the dispatcher would.
    const latestCode = async () => {
      const { data: row } = await service
        .from('member_phones')
        .select('id')
        .eq('phone_e164', phone)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!row) return undefined;
      const { data } = await service
        .from('notifications')
        .select('vars')
        .eq('recipient_ref', row.id)
        .eq('template_key', 'member_verify')
        .limit(1);
      return (data?.[0]?.vars as { code?: string } | undefined)?.code;
    };
    await expect.poll(latestCode).toMatch(/^\d{6}$/);
    const code = (await latestCode())!;
    await staff.getByLabel('Code from the text').fill('000000');
    await staff.getByRole('button', { name: 'Confirm number' }).click();
    await expect(staff.getByRole('status')).toHaveText(/doesn't match/);
    await staff.getByLabel('Code from the text').fill(code);
    await staff.getByRole('button', { name: 'Confirm number' }).click();
    await expect(staff.getByText(`Test texts go to ${phone}.`, { exact: false })).toBeVisible();
    await staff.getByRole('button', { name: 'Text me this message' }).click();
    await expect(staff.getByRole('status')).toContainText(`Sent to ${phone}`);
    await expectNoSeriousA11yViolations(staff);
  });
});

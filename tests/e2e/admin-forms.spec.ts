import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';

// 2A-Q8 (#107), F6 (#1282), B3 (#1286): the forms editor (builder, sensitivity warnings, live
// phone preview) and the attach screen.

test.use({ staffUser: null });

async function queueOf(email: string) {
  const [[loc]] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  const queue = await restAs(email, 'queues', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ org_id: loc!.org_id, location_id: loc!.id, name: 'Clinic' }),
  }).then(async (r) => ((await r.json()) as { id: string }[])[0]!);
  return { queueId: queue.id };
}

test('a sensitive question warns, and the library offers no file upload', async ({ devices }) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await queueOf(email);
  await signInTo(staff, email, '/admin/forms');
  await staff.getByRole('button', { name: 'New form' }).click();

  const library = staff.getByRole('list', { name: 'Field types' });
  expect((await library.allTextContents()).join(' ').toLowerCase()).not.toContain('file');
  await staff.getByRole('button', { name: 'Add Short text' }).click();
  await expect(
    staff.getByRole('status').filter({ hasText: 'This form asks a sensitive question' }),
  ).toHaveCount(0);
  await staff.getByLabel('How sensitive is the answer?').selectOption('sensitive');
  await expect(
    staff.getByRole('status').filter({ hasText: 'This form asks a sensitive question' }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});

test('the phone preview follows the draft, estimates fill time and shows retention', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await queueOf(email);
  await signInTo(staff, email, '/admin/forms');
  await staff.getByRole('button', { name: 'New form' }).click();
  const preview = staff.getByTestId('form-preview');
  await expect(staff.getByTestId('fill-estimate')).toHaveText('Guests have nothing to fill in.');
  await expect(preview).toContainText('Answers are kept for 365 days, then deleted.');

  await staff.getByRole('button', { name: 'Add Short text' }).click();
  await staff.getByLabel('Question', { exact: true }).fill('Party name');
  await expect(preview.getByRole('textbox', { name: /Party name/ })).toBeVisible();
  await expect(staff.getByTestId('fill-estimate')).toHaveText('About 10 seconds to fill in.');

  await staff.getByLabel('Keep answers for (days)').fill('30');
  await expect(preview).toContainText('Answers are kept for 30 days, then deleted.');
  await staff.getByLabel('Who sees this question').selectOption('staff_only');
  await expect(preview.getByRole('textbox', { name: /Party name/ })).toHaveCount(0);
  await expect(staff.getByTestId('fill-estimate')).toHaveText('Guests have nothing to fill in.');
  await expectNoSeriousA11yViolations(staff);
});

test('build a form, attach it to a queue and a service at once, edit, detach with undo', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  const { queueId } = await queueOf(email);
  const [[loc]] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  const svc = await restAs(email, 'services', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      org_id: loc!.org_id,
      location_id: loc!.id,
      queue_id: queueId,
      name: 'Cut',
    }),
  });
  expect(svc.ok, await svc.clone().text()).toBe(true);
  await signInTo(staff, email, '/admin/forms');
  await expect(staff.getByText('No forms yet')).toBeVisible();

  await staff.getByRole('button', { name: 'New form' }).click();
  await staff.getByLabel('Form name').fill('Intake');
  await staff.getByRole('button', { name: 'Add Short text' }).click();
  await staff.getByLabel('Question', { exact: true }).fill('Party name');
  await staff.getByRole('button', { name: 'Add Single choice' }).click();
  await staff.getByLabel('Question', { exact: true }).fill('Seating');
  await staff.getByLabel('Choices').fill('Indoor\nOutdoor');
  await staff.getByRole('button', { name: 'Move Seating up' }).click();
  await staff.getByRole('button', { name: 'Publish' }).click();
  const card = staff.getByTestId('form-card').filter({ hasText: 'Intake' });
  await expect(card).toContainText('Version 1');

  // One action attaches the form to the queue and to its service.
  await card.getByRole('button', { name: 'Show on…' }).click();
  await card.getByLabel('Clinic', { exact: true }).check();
  await card.getByLabel('Clinic / Cut').check();
  await card.getByRole('button', { name: 'Show on 2 places' }).click();
  await expect(card.getByRole('list', { name: 'Shown on' }).getByRole('listitem')).toHaveCount(2);
  const targets = () => readAs(email, ['form_targets?select=queue_id,service_id']);
  expect((await targets())[0]).toHaveLength(2);

  // Editing and publishing again makes version 2 for both targets.
  await card.getByRole('button', { name: 'Edit' }).click();
  await staff.getByRole('button', { name: 'Remove Party name' }).click();
  await staff.getByRole('button', { name: 'Publish' }).click();
  await expect(card).toContainText('Version 2');
  const [versions] = (await readAs(email, [
    'form_versions?select=version,fields&order=version',
  ])) as [{ version: number; fields: { key: string }[] }[]];
  expect(versions!.map((v) => v.fields.map((f) => f.key))).toEqual([
    ['single_choice_1', 'short_text_1'],
    ['single_choice_1'],
  ]);
  expect((await targets())[0]).toHaveLength(2);

  // Detach shows an undo.
  await card.getByRole('button', { name: 'Remove from Clinic / Cut' }).click();
  await expect(card.getByRole('list', { name: 'Shown on' }).getByRole('listitem')).toHaveCount(1);
  await staff.getByRole('button', { name: 'Undo' }).last().click();
  await expect(card.getByRole('list', { name: 'Shown on' }).getByRole('listitem')).toHaveCount(2);
  await expectNoSeriousA11yViolations(staff);
});

import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, signInTo } from './support/accounts.ts';

// 4-AI1 (#394): an owner saves their own key and opts in; a manager then asks a question. The Edge
// Function itself is covered by Deno tests with a fake LLM, so the browser stubs its response here.
test.use({ staffUser: null });

test('an owner opts in, asks a question and sees the table and a plain-text summary; axe is clean', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/reports/ask');
  await expect(staff.getByRole('heading', { name: 'Ask analytics' })).toBeVisible();
  await expect(
    staff.getByText('Analytics questions are switched off for this business.'),
  ).toBeVisible();

  await staff.getByLabel('Anthropic API key').fill('sk-ant-test-0123456789abcdef');
  await staff.getByRole('button', { name: 'Save settings' }).click();
  await staff.mouse.move(0, 0);
  await expect(staff.getByText('A key ending in cdef is saved.')).toBeVisible();
  await staff.getByRole('button', { name: 'Turn on analytics questions' }).click();
  await expect(staff.getByLabel('Your question')).toBeVisible();

  let sent: Record<string, unknown> | undefined;
  await staff.route('**/functions/v1/ask-analytics', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        definition: {
          measures: ['visits'],
          dimensions: ['weekday'],
          from: '2026-03-04',
          to: '2026-03-31',
        },
        rows: [{ dims: { weekday: 2 }, measures: { visits: 9 } }],
        summary: '<b>Tuesday</b> is busiest.',
        remaining: 41,
      }),
    });
  });
  await staff.getByLabel('Your question').fill('Which weekday is busiest?');
  await staff.getByRole('button', { name: 'Ask', exact: true }).click();

  await expect(staff.getByTestId('summary')).toHaveText('<b>Tuesday</b> is busiest.');
  await expect(staff.getByRole('cell', { name: 'Tuesday' })).toBeVisible();
  await expect(staff.getByRole('cell', { name: '9' })).toBeVisible();
  await expect(staff.getByText('41 questions left today.')).toBeVisible();
  expect(sent).toMatchObject({ question: 'Which weekday is busiest?' });
  await expectNoSeriousA11yViolations(staff);
});

test('a refused question shows the friendly message', async ({ devices }) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/reports/ask');
  await staff.getByLabel('Anthropic API key').fill('sk-ant-test-0123456789abcdef');
  await staff.getByRole('button', { name: 'Save settings' }).click();
  await staff.mouse.move(0, 0);
  await staff.getByRole('button', { name: 'Turn on analytics questions' }).click();
  await staff.route('**/functions/v1/ask-analytics', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ error: 'couldnt_answer' }),
    }),
  );
  await staff.getByLabel('Your question').fill('What is the meaning of life?');
  await staff.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(staff.getByRole('alert').filter({ hasText: "couldn't answer" })).toBeVisible();
});

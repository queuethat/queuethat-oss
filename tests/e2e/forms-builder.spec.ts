import type { Locator, Page } from '@playwright/test';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';

// B4 (#1287): the form builder end to end. Keyboard-only build, mouse and touch drag, and axe on
// every state. No timing sleeps: every wait is an expectation on the page.

test.use({ staffUser: null });

/** Phone layout (< 640px, Tailwind `sm`): the builder offers no dragging there. */
const isPhone = (page: Page) => (page.viewportSize()?.width ?? Infinity) < 640;

async function queueOf(email: string) {
  const [[loc]] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  await restAs(email, 'queues', {
    method: 'POST',
    body: JSON.stringify({ org_id: loc!.org_id, location_id: loc!.id, name: 'Clinic' }),
  });
}

async function openNewForm(page: Page) {
  const { email } = await ownerOfNewBusiness();
  await queueOf(email);
  await signInTo(page, email, '/admin/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  return email;
}

/** Presses Tab until `target` has focus, so the test only reaches what a keyboard can. */
async function tabTo(page: Page, target: Locator, backwards = false) {
  const key = backwards ? 'Shift+Tab' : 'Tab';
  for (let i = 0; i < 120; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`Never reached ${String(target)} by keyboard`);
}

/** The canvas row labels in order. */
const order = (page: Page) => page.locator('[data-sortable-item] p.font-medium').allTextContents();

async function addByTap(page: Page, type: string, question: string) {
  await page.getByRole('button', { name: `Add ${type}` }).click();
  await page.getByLabel('Question', { exact: true }).fill(question);
}

test('build and publish a form with the keyboard alone', async ({ devices }) => {
  const { staff } = devices;
  test.skip(isPhone(staff), 'Phone width has no drag handle; the buttons are covered below');
  const email = await openNewForm(staff);

  await tabTo(staff, staff.getByLabel('Form name'));
  await staff.keyboard.type('Keyboard intake');

  await tabTo(staff, staff.getByRole('button', { name: 'Add Short text' }));
  await staff.keyboard.press('Enter');
  await expect(staff.getByRole('status').filter({ hasText: 'Short text added' })).toBeAttached();
  await tabTo(staff, staff.getByLabel('Question', { exact: true }));
  await staff.keyboard.press('ControlOrMeta+A');
  await staff.keyboard.type('Party name');

  await tabTo(staff, staff.getByRole('button', { name: 'Add Yes / no' }), true);
  await staff.keyboard.press('Space');
  await tabTo(staff, staff.getByLabel('Question', { exact: true }));
  await staff.keyboard.press('ControlOrMeta+A');
  await staff.keyboard.type('Allergies');
  await expect.poll(() => order(staff)).toEqual(['Party name', 'Allergies']);

  // Pick up "Allergies", move it above "Party name" with the arrow keys, drop it.
  const handle = staff.getByRole('button', { name: 'Reorder Allergies' });
  await tabTo(staff, handle);
  await staff.keyboard.press('Space');
  await expect(staff.getByRole('status').filter({ hasText: 'Allergies picked up' })).toBeAttached();
  await staff.keyboard.press('ArrowUp');
  await expect(handle).toBeFocused();
  await staff.keyboard.press('Space');
  await expect(
    staff.getByRole('status').filter({ hasText: 'Allergies dropped at position 1 of 2' }),
  ).toBeAttached();
  expect(await order(staff)).toEqual(['Allergies', 'Party name']);

  // Escape puts a held field back.
  await staff.keyboard.press('Space');
  await staff.keyboard.press('ArrowDown');
  await expect.poll(() => order(staff)).toEqual(['Party name', 'Allergies']);
  await staff.keyboard.press('Escape');
  await expect.poll(() => order(staff)).toEqual(['Allergies', 'Party name']);

  // Removing offers undo, also by keyboard.
  const remove = staff.getByRole('button', { name: 'Remove Party name' });
  await tabTo(staff, remove);
  await staff.keyboard.press('Enter');
  await expect.poll(() => order(staff)).toEqual(['Allergies']);
  await staff.getByRole('button', { name: 'Undo' }).last().focus();
  await staff.keyboard.press('Enter');
  await expect.poll(() => order(staff)).toEqual(['Allergies', 'Party name']);

  await expectNoSeriousA11yViolations(staff);

  await tabTo(staff, staff.getByRole('button', { name: 'Publish' }));
  await staff.keyboard.press('Enter');
  await expect(staff.getByTestId('form-card').filter({ hasText: 'Keyboard intake' })).toContainText(
    'Version 1',
  );
  const [versions] = (await readAs(email, ['form_versions?select=fields'])) as [
    { fields: { label: string }[] }[],
  ];
  expect(versions![0]!.fields.map((f) => f.label)).toEqual(['Allergies', 'Party name']);
});

test('tap adds a field and the move buttons reorder it', async ({ devices }) => {
  const { staff } = devices;
  await openNewForm(staff);
  await staff.getByRole('button', { name: 'Add Short text' }).tap();
  await staff.getByLabel('Question', { exact: true }).fill('First');
  await staff.getByRole('button', { name: 'Add Long text' }).tap();
  await staff.getByLabel('Question', { exact: true }).fill('Second');
  await expect.poll(() => order(staff)).toEqual(['First', 'Second']);
  if (isPhone(staff)) {
    await expect(staff.getByRole('button', { name: /^Reorder / })).toHaveCount(0);
  }
  await staff.getByRole('button', { name: 'Move Second up' }).tap();
  await expect.poll(() => order(staff)).toEqual(['Second', 'First']);
  await expectNoSeriousA11yViolations(staff);
});

test('drag a type onto the form and reorder by drag', async ({ devices, browserName }) => {
  const { staff } = devices;
  test.skip(isPhone(staff), 'No drag at phone width');
  await openNewForm(staff);
  await addByTap(staff, 'Short text', 'One');
  await addByTap(staff, 'Long text', 'Two');
  await addByTap(staff, 'Number', 'Three');
  await expect.poll(() => order(staff)).toEqual(['One', 'Two', 'Three']);

  // Mouse: drag a library type into the gap above the first row.
  const first = await staff.locator('[data-sortable-item]').first().boundingBox();
  const type = await staff.getByRole('button', { name: 'Add Email' }).boundingBox();
  await staff.mouse.move(type!.x + type!.width / 2, type!.y + type!.height / 2);
  await staff.mouse.down();
  await staff.mouse.move(first!.x + 40, first!.y + 2, { steps: 8 });
  await staff.mouse.up();
  await expect(staff.locator('[data-sortable-item]')).toHaveCount(4);
  await expect(staff.locator('[data-sortable-item]').first()).toContainText('Email');
  await staff.getByLabel('Question', { exact: true }).fill('Mail');

  // Reorder: drag the handle of "Three" above the first row. Touch where the engine has it.
  // Bring the list to the top of the viewport so every row is reachable by the pointer.
  await staff.getByRole('heading', { name: /^Your form/ }).evaluate((h) => h.scrollIntoView());
  const handle = await staff.getByRole('button', { name: 'Reorder Three' }).boundingBox();
  const top = await staff.locator('[data-sortable-item]').first().boundingBox();
  const from = { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 };
  const to = { x: from.x, y: top!.y + 2 };
  if (browserName === 'chromium') {
    const cdp = await staff.context().newCDPSession(staff);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p?: { x: number; y: number }) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [],
      });
    await touch('touchStart', from);
    for (let i = 1; i <= 8; i++) {
      await touch('touchMove', { x: from.x, y: from.y + ((to.y - from.y) * i) / 8 });
    }
    await touch('touchEnd');
  } else {
    // Playwright cannot synthesise touch drags in WebKit; the same pointer handlers run for a mouse.
    await staff.mouse.move(from.x, from.y);
    await staff.mouse.down();
    await staff.mouse.move(to.x, to.y, { steps: 8 });
    await staff.mouse.up();
  }
  await expect.poll(() => order(staff)).toEqual(['Three', 'Mail', 'One', 'Two']);
  await expectNoSeriousA11yViolations(staff);
});

test('every editor state passes axe', async ({ devices }) => {
  const { staff } = devices;
  await openNewForm(staff);
  await expectNoSeriousA11yViolations(staff); // empty canvas
  await addByTap(staff, 'Single choice', 'Seating');
  await staff.getByLabel('Choices').fill('Indoor\nIndoor');
  await expect(staff.getByText('Each choice must be different.')).toBeVisible();
  await expectNoSeriousA11yViolations(staff); // field error
  await staff.getByLabel('How sensitive is the answer?').selectOption('sensitive');
  await expect(staff.getByText('This form asks a sensitive question')).toBeVisible();
  await expectNoSeriousA11yViolations(staff); // sensitivity warning
  await staff.getByRole('button', { name: 'Remove Seating' }).click();
  await expect(staff.getByRole('button', { name: 'Undo' }).last()).toBeVisible();
  await expectNoSeriousA11yViolations(staff); // undo toast
});

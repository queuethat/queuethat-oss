import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import type { Locator, Page } from '@playwright/test';
import { freshQueue } from './support/queues.ts';

// #1176: older guests raise the browser font size. The join and status pages must stay usable at
// 200% (I-9: primary actions >= 48 px). Test only: real failures are filed as separate issues.

const MIN_TARGET_PX = 48;

/**
 * Emulates "browser font size: 200%". Playwright can't change the browser's font setting, so this
 * scales the root font size, which is what the setting does to rem-based layouts. Set through the
 * style object so a strict CSP can't block it. Call after `goto`; the visit's SPA navigation keeps it.
 */
async function enlargeText(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
  expect(overflow.scrollWidth, 'page scrolls sideways').toBeLessThanOrEqual(overflow.clientWidth);
}

async function expectTarget(button: Locator, label: string): Promise<void> {
  await expect(button, `${label} visible`).toBeVisible();
  const box = await button.boundingBox();
  expect(box, `${label} has a box`).not.toBeNull();
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(MIN_TARGET_PX);
}

/** No button's content spills outside the button, in either direction. */
async function expectNoClippedButtons(page: Page): Promise<void> {
  const clipped = await page.evaluate(() => {
    const out: string[] = [];
    for (const button of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
      const rect = button.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const name = (button.textContent ?? '').trim().slice(0, 40);
      if (button.scrollWidth > button.clientWidth + 1) out.push(`${name}: scrollWidth`);
      if (button.scrollHeight > button.clientHeight + 1) out.push(`${name}: scrollHeight`);
      const range = document.createRange();
      range.selectNodeContents(button);
      for (const r of range.getClientRects()) {
        if (
          r.left < rect.left - 1 ||
          r.right > rect.right + 1 ||
          r.top < rect.top - 1 ||
          r.bottom > rect.bottom + 1
        ) {
          out.push(`${name}: text outside box`);
          break;
        }
      }
    }
    return out;
  });
  expect(clipped, 'clipped button text').toEqual([]);
}

/** Opens the poster page at 200% text and fills the form; the caller clicks Join. */
async function openJoinPage(page: Page): Promise<Locator> {
  const queue = await freshQueue();
  await page.goto(`/q/${demo.locationSlug}`);
  await enlargeText(page);
  const fontSize = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  expect(fontSize).toBe('32px');
  await page.getByLabel('Queue').selectOption(queue.id);
  await page.getByLabel('First name').fill('Large Text');
  const join = page.getByRole('button', { name: 'Join the queue' });
  await join.scrollIntoViewIfNeeded();
  return join;
}

/** Joins through the UI (AC2, never by RPC) and waits for the status page. */
async function openStatusPage(page: Page): Promise<void> {
  const join = await openJoinPage(page);
  await join.click();
  await expect(page).toHaveURL(/\/v\/[\w-]+$/);
  await expect(page.getByTestId('ticket')).toBeVisible();
}

test('join page at 200% text does not scroll sideways', async ({ page }) => {
  await openJoinPage(page);
  await expectNoHorizontalScroll(page);
});

test('join page at 200% text: 48 px join button, nothing clipped, axe clean', async ({ page }) => {
  const join = await openJoinPage(page);
  await expectTarget(join, 'Join the queue');
  await expectNoClippedButtons(page);
  await expectNoSeriousA11yViolations(page);
  await join.click();
  await expect(page).toHaveURL(/\/v\/[\w-]+$/);
});

test('status page at 200% text does not scroll sideways', async ({ page }) => {
  await openStatusPage(page);
  await expectNoHorizontalScroll(page);
});

test('status page at 200% text: Leave button and its dialog stay usable', async ({ page }) => {
  await openStatusPage(page);
  const leave = page.getByRole('button', { name: 'Leave the line' });
  await leave.scrollIntoViewIfNeeded();
  await expectTarget(leave, 'Leave the line');
  await expectNoClippedButtons(page);
  await expectNoSeriousA11yViolations(page);

  // The confirm dialog is part of the Leave flow and must hold up at the same size.
  await leave.click();
  const dialog = page.getByRole('dialog', { name: 'Leave the line?' });
  await expect(dialog).toBeVisible();
  await expectTarget(dialog.getByRole('button', { name: 'Stay in line' }), 'Stay in line');
  await expectTarget(dialog.getByRole('button', { name: 'Yes, leave' }), 'Yes, leave');
  await expectNoClippedButtons(page);
  await expectNoSeriousA11yViolations(page);
});

import type { Page } from '@playwright/test';

/** Types a pairing code on a screen that shows the pairing form. */
export async function pair(page: Page, code: string) {
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair' }).click();
}

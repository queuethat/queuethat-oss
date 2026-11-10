import type { Page } from '@playwright/test';

/**
 * Runs one tenant action from the console's org detail, as an operator does: open the dialog,
 * give a reason, type the slug back and confirm. The page must already be on the org's detail.
 */
export async function runTenantAction(
  page: Page,
  action: { trigger: string; confirm: string; slug: string; reason: string },
): Promise<void> {
  await page.getByRole('button', { name: action.trigger }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill(action.reason);
  await dialog.getByLabel(/^Type /).fill(action.slug);
  await dialog.getByRole('button', { name: action.confirm }).click();
}

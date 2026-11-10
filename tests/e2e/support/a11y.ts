import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Fails when axe finds a serious or critical WCAG 2.1 A/AA violation on the page. Minor and
 * moderate findings are left to review. The message lists each rule and its first target.
 */
export async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes[0]?.target.join(' ') ?? 'page'})`);
  expect(serious, `axe violations on ${page.url()}`).toEqual([]);
}

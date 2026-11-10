import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Fails when axe finds a serious or critical WCAG 2.1 A/AA violation on the page. Minor and
 * moderate findings are left to review. The message lists each rule and its first target.
 * Waits for running CSS transitions first, so the page is judged in its settled state.
 */
export async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  // A colour that is still transitioning (a tab that was just selected, say) is measured at
  // whatever shade it has reached, which can fall below the contrast threshold for a few frames.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a instanceof CSSTransition)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes[0]?.target.join(' ') ?? 'page'})`);
  expect(serious, `axe violations on ${page.url()}`).toEqual([]);
}

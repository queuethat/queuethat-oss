import type { Page } from '@playwright/test';
import { demo } from '../fixtures/demo.ts';
import { expect, signIn, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// O3 (#74). The report-only CSP must already pass on every screen, so enforcing it later
// breaks nothing. Runs against the production build behind `vite preview` (which sends
// public/_headers), never the dev server, whose injected inline styles would always fail.

const previewUrl = process.env.E2E_PREVIEW_URL!;

interface Violation {
  directive: string;
  blocked: string;
  source: string;
}

/**
 * Records CSP violations and CSP console errors on `page`. Calls to the local API are left
 * out: production allows https://*.supabase.co and wss://*.supabase.co (realtime), but the local
 * stack is http://127.0.0.1:55321 and ws://127.0.0.1:55321.
 */
async function watchCsp(page: Page) {
  const apiOrigin = new URL(supabaseEnv().url).origin;
  const realtimeOrigin = apiOrigin.replace(/^http/, 'ws');
  const local = (url: string) => url.startsWith(apiOrigin) || url.startsWith(realtimeOrigin);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() !== 'error' || !/content security policy/i.test(text)) return;
    // WebKit logs this on every page until the policy has a report-to endpoint, which is
    // deferred to observability (O6). Violations still fire as events, which we check below.
    if (text.includes("does not specify a 'report-to'")) return;
    if (!text.includes(apiOrigin) && !text.includes(realtimeOrigin)) consoleErrors.push(text);
  });
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
        source: `${event.sourceFile}:${event.lineNumber}`,
      });
    });
  });
  return async () => {
    const violations = await page.evaluate(
      () => (window as unknown as { __cspViolations: Violation[] }).__cspViolations,
    );
    return {
      violations: violations.filter((v) => !local(v.blocked)),
      consoleErrors,
    };
  };
}

const guestPaths = [
  '/',
  `/q/${demo.locationSlug}`,
  '/v/not-a-real-token',
  '/auth/sign-in',
  '/display',
  '/kiosk',
];

for (const path of guestPaths) {
  test(`${path} raises no CSP violations`, async ({ page }) => {
    const report = await watchCsp(page);
    const response = await page.goto(`${previewUrl}${path}`, { waitUntil: 'networkidle' });
    expect(response?.headers()['content-security-policy-report-only']).toContain(
      "style-src 'self'",
    );
    expect(await report()).toEqual({ violations: [], consoleErrors: [] });
  });
}

for (const path of ['/staff', '/admin']) {
  test(`${path} signed in raises no CSP violations`, async ({ page }) => {
    await signIn(page, 'owner');
    const report = await watchCsp(page);
    await page.goto(`${previewUrl}${path}`, { waitUntil: 'networkidle' });
    expect(await report()).toEqual({ violations: [], consoleErrors: [] });
  });
}

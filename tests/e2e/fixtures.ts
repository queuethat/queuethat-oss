import { rm } from 'node:fs/promises';
import { test as base, devices as descriptors, type Page } from '@playwright/test';
import { signIn } from './support/auth.ts';
import type { TestUserRole } from './support/users.ts';

export { expect } from '@playwright/test';
export { expectNoSeriousA11yViolations } from './support/a11y.ts';
export { eventually, LIVE_TIMEOUT_MS } from './support/poll.ts';
export { signIn, signInAs } from './support/auth.ts';

/** The three clients a queue runs on. */
export interface Devices {
  /** A guest's phone. Signed out. */
  guest: Page;
  /** A staff member's tablet, signed in as `staffUser`. */
  staff: Page;
  /** The TV in the waiting area. Unpaired until device pairing (D1) adds a hook here. */
  display: Page;
}

type DeviceProfile = Omit<(typeof descriptors)[string], 'defaultBrowserType'>;

/** Hardware each role uses, per engine, so all three pages share the project's browser. */
const profiles: Record<'chromium' | 'webkit', Record<keyof Devices, DeviceProfile>> = {
  chromium: {
    guest: descriptors['Pixel 7'],
    staff: descriptors['Galaxy Tab S9'],
    display: { ...descriptors['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
  },
  webkit: {
    guest: descriptors['iPhone 15'],
    staff: descriptors['iPad Pro 11'],
    display: { ...descriptors['Desktop Safari'], viewport: { width: 1920, height: 1080 } },
  },
};

interface Options {
  /** Who the staff tablet signs in as. `null` leaves it signed out. */
  staffUser: TestUserRole | null;
}

export const test = base.extend<Options & { devices: Devices; freshQueues: void }>({
  staffUser: ['staff', { option: true }],

  // Every test, so queues from freshQueue() never pile up across a run.
  freshQueues: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads fixture deps from the pattern.
    async ({}, use) => {
      await use();
      // Against the pilot there is no service role; support/shop.ts cleans up its own queue.
      if (process.env.E2E_PILOT === '1') return;
      const { archiveFreshQueues } = await import('./support/queues.ts');
      await archiveFreshQueues();
    },
    { auto: true },
  ],

  devices: async ({ browser, browserName, staffUser, video }, use, testInfo) => {
    if (browserName === 'firefox') throw new Error('No device profiles for firefox.');
    const roles = ['guest', 'staff', 'display'] as const;
    // Playwright only records the built-in `page`, so these contexts honour `video` themselves.
    const videoMode = typeof video === 'string' ? video : video.mode;
    const opened = await Promise.all(
      roles.map(async (role) => {
        const { userAgent, viewport, deviceScaleFactor, isMobile, hasTouch } =
          profiles[browserName][role];
        const context = await browser.newContext({
          userAgent,
          viewport,
          deviceScaleFactor,
          isMobile,
          hasTouch,
          ...(videoMode === 'off' ? {} : { recordVideo: { dir: testInfo.outputPath(role) } }),
        });
        return { role, context, page: await context.newPage() };
      }),
    );
    const pages = Object.fromEntries(opened.map((o) => [o.role, o.page])) as unknown as Devices;
    if (staffUser) await signIn(pages.staff, staffUser);
    await use(pages);

    await Promise.all(opened.map((o) => o.context.close()));
    const failed = testInfo.status !== testInfo.expectedStatus;
    const keep = videoMode === 'on' || (failed && videoMode !== 'off');
    for (const { role, page } of opened) {
      const path = await page.video()?.path();
      if (path && keep) {
        await testInfo.attach(`video-${role}`, { path, contentType: 'video/webm' });
      }
      // `attach` copies the file, so the recording folder can always go.
      await rm(testInfo.outputPath(role), { recursive: true, force: true });
    }
  },
});

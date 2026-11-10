import type { Page, Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomInt } from 'node:crypto';
import { supabaseDeps } from '../../../supabase/functions/public-join/deps.ts';
import { createPublicJoinHandler } from '../../../supabase/functions/public-join/handler.ts';
import { supabaseEnv } from './env.ts';

const ORIGIN = 'http://localhost:5173';

/**
 * Runs the public-join Edge Function's own handler in Node behind page.route (CI has no edge
 * runtime), against the real database, from a network address of its own.
 */
export async function withPublicJoin(
  page: Page,
  provider: 'pow' | 'dev',
  tweak: (deps: ReturnType<typeof supabaseDeps>) => ReturnType<typeof supabaseDeps> = (d) => d,
) {
  const env = supabaseEnv();
  const deps = tweak(
    supabaseDeps(createClient, {
      url: env.url,
      serviceRoleKey: env.serviceRoleKey,
      publicUrl: ORIGIN,
      captchaProvider: provider,
      powSecret: 'e2e-pow-secret-0123456789abcdef',
      powDifficulty: 8,
      environment: 'test',
      // A network of its own, so parallel specs never share a rate bucket.
      ipSalt: `e2e-${randomInt(1e9)}`,
    }),
  );
  const handler = createPublicJoinHandler(deps);
  const ip = `203.0.113.${randomInt(1, 250)}`;
  await page.addInitScript((value) => localStorage.setItem('qm:dev:public-join', value), provider);
  await page.route('**/functions/v1/public-join**', async (route: Route) => {
    const request = route.request();
    try {
      const answer = await handler(
        new Request(request.url(), {
          method: request.method(),
          headers: { ...request.headers(), 'x-real-ip': ip },
          body: request.method() === 'POST' ? request.postData() : undefined,
        }),
      );
      await route.fulfill({
        status: answer.status,
        headers: Object.fromEntries(answer.headers),
        body: await answer.text(),
      });
    } catch (error) {
      // The page went away while the handler worked: the guest left, not a failure.
      if (!page.isClosed() && !/disposed|closed|has been/i.test(String(error))) throw error;
    }
  });
}

// public-join entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { supabaseDeps } from './deps.ts';
import { createPublicJoinHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
const num = (name: string) => (Deno.env.get(name) ? Number(Deno.env.get(name)) : undefined);

const observe = createObserver('public-join', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createPublicJoinHandler({
    ...supabaseDeps(createClient, {
      url: env('SUPABASE_URL'),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
      publicUrl: env('PUBLIC_URL'),
      captchaProvider: env('CAPTCHA_PROVIDER'),
      turnstileSecret: Deno.env.get('TURNSTILE_SECRET_KEY'),
      powSecret: Deno.env.get('POW_SECRET'),
      powDifficulty: num('POW_DIFFICULTY'),
      environment: Deno.env.get('ENVIRONMENT'),
      ipSalt: Deno.env.get('PUBLIC_JOIN_IP_SALT'),
      clientIpHeader: Deno.env.get('CLIENT_IP_HEADER') === 'cf-connecting-ip' ? 'cf-connecting-ip' : 'x-real-ip',
      ipLimit: num('PUBLIC_JOIN_IP_LIMIT'),
      ipWindowSeconds: num('PUBLIC_JOIN_IP_WINDOW_SECONDS'),
    }),
    error: observe.error,
  })),
);

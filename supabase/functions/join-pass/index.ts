// join-pass entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { supabaseDeps } from './deps.ts';
import { createJoinPassHandler, turnstileVerifier } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('join-pass', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createJoinPassHandler({
    ...supabaseDeps(createClient, {
      url: env('SUPABASE_URL'),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    }),
    verify: turnstileVerifier(env('TURNSTILE_SECRET_KEY'), fetch, observe.error),
    error: observe.error,
  })),
);

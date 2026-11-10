// 2A-TM1 (#95): invite-staff Edge Function entry point. The logic and its contract are in handler.ts.
// verify_jwt stays on (supabase/config.toml): only signed-in members get this far, and the database
// then decides whether they may invite.
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { supabaseDeps } from './deps.ts';
import { createInviteStaffHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('invite-staff', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createInviteStaffHandler({
    ...supabaseDeps(createClient, {
      url: env('SUPABASE_URL'),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
      anonKey: env('SUPABASE_ANON_KEY'),
      siteUrl: env('PUBLIC_SITE_URL'),
    }),
    // Every line invite-staff logs is a failure.
    log: observe.error,
  })),
);

// ics-feed entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { supabaseDeps } from './deps.ts';
import { createObserver } from '../_shared/observe.ts';
import { createFeedHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('ics-feed', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createFeedHandler({
    ...supabaseDeps(createClient, {
      url: env('SUPABASE_URL'),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    }),
    error: observe.error,
  })),
);

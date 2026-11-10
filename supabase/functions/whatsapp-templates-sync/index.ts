// 3-WA4 (#361): whatsapp-templates-sync entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { supabaseDeps } from './deps.ts';
import { createSyncHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('whatsapp-templates-sync', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createSyncHandler({
    ...supabaseDeps(createClient, {
      url: env('SUPABASE_URL'),
      anonKey: env('SUPABASE_ANON_KEY'),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    }),
    log: observe.error,
  })),
);

// 2P-RPT4 (#200): export-data Edge Function entry point. The logic and its contract are in handler.ts.
// verify_jwt stays on (supabase/config.toml). Every read uses the caller's own JWT, so RLS decides
// what is exported; the service role key is never used here.
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { supabaseDeps } from './deps.ts';
import { createExportHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('export-data', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createExportHandler({
    ...supabaseDeps(createClient, { url: env('SUPABASE_URL'), anonKey: env('SUPABASE_ANON_KEY') }),
    log: observe.error,
  })),
);

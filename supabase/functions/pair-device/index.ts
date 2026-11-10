// D1 (#48): pair-device Edge Function entry point. The logic and its contract are in handler.ts.
// It needs the service role (Auth admin API and the service-role-only pairing RPCs), which is why
// this is an Edge Function and not an RPC (technical-design.md 3.5, rule 3).
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { supabaseDeps } from './deps.ts';
import { createPairDeviceHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('pair-device', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createPairDeviceHandler({
    ...supabaseDeps(createClient, {
      url: env('SUPABASE_URL'),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
      anonKey: env('SUPABASE_ANON_KEY'),
    }),
    // Every line pair-device logs is a failure.
    log: observe.error,
  })),
);

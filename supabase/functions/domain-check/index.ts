// 3-DOM1 (#370): domain-check entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { dohTxt, supabaseDeps } from './deps.ts';
import { createDomainCheckHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('domain-check', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createDomainCheckHandler({
    ...supabaseDeps(createClient, {
      url: env('SUPABASE_URL'),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
      anonKey: env('SUPABASE_ANON_KEY'),
    }),
    txt: dohTxt(),
    secret: Deno.env.get('DISPATCH_SECRET') ?? '',
    log: observe.log,
  })),
);

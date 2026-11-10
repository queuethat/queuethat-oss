// 2P-PRV8 (#195): purge-org entry point. The logic and its contract are in handler.ts. An Edge
// Function because deleting auth users and storage objects needs the service role, which never
// leaves it (technical-design.md 3.5, rule 3).
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { supabaseDeps } from './deps.ts';
import { createPurgeOrgHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('purge-org', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createPurgeOrgHandler({
    ...supabaseDeps(createClient, {
      url: env('SUPABASE_URL'),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    }),
    secret: Deno.env.get('DISPATCH_SECRET') ?? '',
    log: observe.log,
  })),
);

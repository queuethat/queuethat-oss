// O6 (#77): health entry point. The logic and its contract are in handler.ts. An Edge Function
// because the report needs the service role, which must not leave the server.
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { createHealthHandler, type HealthReport } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const api = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('api');
const observe = createObserver('health', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createHealthHandler({
    async report() {
      const { data, error } = await api.rpc('health_report');
      if (error) throw new Error(error.message);
      return data as HealthReport;
    },
    error: observe.error,
  })),
);

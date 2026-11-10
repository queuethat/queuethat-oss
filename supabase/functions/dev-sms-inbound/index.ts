// 2P-NTF10 (#182): dev-sms-inbound entry point. The logic and its contract are in handler.ts.
// verify_jwt stays on (supabase/config.toml); handler.ts re-checks the user and the dev switch.
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { createDevSmsInboundHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('dev-sms-inbound', Deno.env.get('SENTRY_DSN'));
const enabled = Deno.env.get('DEV_INBOX_ENABLED') === 'true';
// Not even a client unless enabled: a deployment without the flag never touches the service role here.
const admin = enabled
  ? createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  : null;

Deno.serve(
  observe.serve(createDevSmsInboundHandler({
    enabled,
    async authenticate(jwt) {
      const { data, error } = await admin!.auth.getUser(jwt);
      return error ? null : data.user?.id ?? null;
    },
    async record(orgId, actor, fromE164, body) {
      const { data, error } = await admin!.schema('api').rpc('dev_record_inbound', {
        p_org_id: orgId,
        p_actor: actor,
        p_from_e164: fromE164,
        p_body: body,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    log: observe.error,
  })),
);

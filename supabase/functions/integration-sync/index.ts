// integration-sync entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { hubspotAdapter, squareAdapter } from '@qm/providers';
import { logInfo } from '../_shared/log.ts';
import { createIntegrationSyncHandler, type IntegrationReport } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const api = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('api');

Deno.serve(createIntegrationSyncHandler({
  adapters: { square: squareAdapter(), hubspot: hubspotAdapter() },
  secret: env('DISPATCH_SECRET'),
  async claim(limit, leaseSeconds) {
    const { data, error } = await api.rpc('claim_integration_jobs', { p_limit: limit, p_lease_seconds: leaseSeconds });
    if (error) throw new Error('claim_integration_jobs');
    return (data ?? []) as never;
  },
  async report(jobId, result: IntegrationReport) {
    const { error } = await api.rpc('report_integration_result', { p_job_id: jobId, p_result: result });
    if (error) throw new Error('report_integration_result');
  },
  async saveTokens(orgId, channel, tokens) {
    const { error } = await api.rpc('save_integration_tokens', {
      p_org_id: orgId, p_channel: channel, p_secrets: tokens.secrets, p_config: tokens.config, p_verified: false,
    });
    if (error) throw new Error('save_integration_tokens');
  },
  log: (line) => logInfo(line),
}));

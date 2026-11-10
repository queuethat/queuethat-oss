import type { SupabaseClient } from '@supabase/supabase-js';
import { demo } from '../../fixtures/demo.ts';

/**
 * Switches texts on for the demo business, as an owner would after the channel gate (3-CG13). The
 * opt-in is offered only then. Call it before the page under test loads.
 */
export async function enableDemoSms(service: SupabaseClient) {
  const { error } = await service.schema('app').from('provider_settings').upsert(
    {
      org_id: demo.orgId,
      channel: 'sms',
      provider: 'dev',
      mode: 'own',
      enabled: true,
      verified_at: new Date().toISOString(),
    },
    { onConflict: 'org_id,channel' },
  );
  if (error) throw error;
}

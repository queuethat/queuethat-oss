// The Supabase side of provider-webhook; index.ts passes Deno's supabase-js.
import type { ProviderWebhookDeps } from './handler.ts';
import type { InboundMessage } from './handlers/twilio.ts';

// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; serviceRoleKey: string },
): Pick<ProviderWebhookDeps, 'endpointSecrets' | 'record' | 'markProcessed'> & {
  processInbound(m: InboundMessage): Promise<unknown>;
  phoneNumberId(orgId: string): Promise<string | null>;
} {
  const api = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).schema('api');
  return {
    async endpointSecrets(provider, endpointId) {
      const { data, error } = await api.rpc('get_webhook_secret', { p_provider: provider, p_endpoint_id: endpointId });
      // get_webhook_secret raises not_found for an unknown endpoint: answer it like a bad signature, not a 500.
      if (error?.message === 'not_found') return null;
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.org_id) return null;
      // secrets is a jsonb array of signing secrets, or {signing: [...], verify_token} for Meta.
      const s = row.secrets;
      const signing = Array.isArray(s) ? s : (s?.signing ?? []);
      return {
        orgId: row.org_id,
        secrets: signing.filter((x: unknown): x is string => typeof x === 'string' && x !== ''),
        verifyToken: typeof s?.verify_token === 'string' ? s.verify_token : undefined,
      };
    },
    async record(provider, eventKey, orgId, payload) {
      const { data, error } = await api.rpc('record_webhook_event', {
        p_provider: provider, p_event_key: eventKey, p_org_id: orgId, p_payload: payload ?? {},
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      return { eventId: Number(row.event_id), isDuplicate: row.is_duplicate === true };
    },
    async processInbound(m: InboundMessage) {
      const { error } = await api.rpc('process_inbound_message', {
        p_org_id: m.orgId, p_channel: m.channel, p_from: m.from, p_to: m.to, p_body: m.body,
        p_provider: m.provider, p_provider_message_id: m.providerMessageId,
      });
      if (error) throw new Error(error.message);
    },
    async phoneNumberId(orgId: string) {
      const { data, error } = await api.rpc('get_channel_config', { p_org_id: orgId, p_channel: 'whatsapp' });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      const id = row?.enabled ? row.config?.phone_number_id : null;
      return typeof id === 'string' && id !== '' ? id : null;
    },
    async markProcessed(eventId, errorText) {
      const { error } = await api.rpc('mark_webhook_processed', { p_event_id: eventId, p_error: errorText ?? null });
      if (error) throw new Error(error.message);
    },
  };
}

// 3-WA4 (#361): the Supabase and Graph side of whatsapp-templates-sync.
import type { Mapping, MetaTemplate, SyncDeps } from './handler.ts';

// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

const MAX_PAGES = 10;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; anonKey: string; serviceRoleKey: string },
  doFetch: typeof fetch = fetch,
): Omit<SyncDeps, 'log'> {
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const asCaller = (jwt: string) =>
    createClient(env.url, env.anonKey, { ...options, global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const service = () => createClient(env.url, env.serviceRoleKey, options);

  return {
    async isAdmin(jwt, orgId) {
      const client = asCaller(jwt);
      const { data: user } = await client.auth.getUser(jwt);
      if (!user?.user) return false;
      const { data, error } = await client
        .schema('app')
        .from('memberships')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', user.user.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.role === 'owner' || data?.role === 'admin';
    },
    async config(orgId) {
      const { data, error } = await service().schema('api').rpc('get_channel_config', { p_org_id: orgId, p_channel: 'whatsapp' });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      const wabaId = row?.config?.waba_id;
      const accessToken = row?.secrets?.access_token;
      if (!row?.enabled || typeof wabaId !== 'string' || typeof accessToken !== 'string') return null;
      const version = row.config?.graph_version;
      return { wabaId, accessToken, graphVersion: typeof version === 'string' && /^v\d+\.\d+$/.test(version) ? version : 'v21.0' };
    },
    async mappings(jwt, orgId): Promise<Mapping[]> {
      const { data, error } = await asCaller(jwt)
        .schema('app')
        .from('whatsapp_templates')
        .select('id, wa_name, wa_language, wa_category')
        .eq('org_id', orgId);
      if (error) throw new Error(error.message);
      return data as Mapping[];
    },
    async metaTemplates(wabaId, accessToken, graphVersion): Promise<MetaTemplate[]> {
      if (!/^\d+$/.test(wabaId)) throw new Error('bad waba_id');
      const out: MetaTemplate[] = [];
      let url: string | null =
        `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates?fields=name,language,status,category&limit=200`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const res = await doFetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`graph ${res.status}`);
        const body = (await res.json()) as { data?: MetaTemplate[]; paging?: { next?: string } };
        out.push(...(body.data ?? []));
        // Only follow Meta's own host; the token goes with every request.
        const next: string | undefined = body.paging?.next;
        url = next && new URL(next).origin === 'https://graph.facebook.com' ? next : null;
      }
      return out;
    },
    async setStatus(jwt, id, status) {
      const { error } = await asCaller(jwt)
        .schema('app')
        .from('whatsapp_templates')
        .update({ status, synced_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },
  };
}

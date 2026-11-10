// 2P-RPT4 (#200): the Supabase side of export-data, built from whichever supabase-js the runtime has.
import type { ExportDeps, Row, Ticket } from './handler.ts';

/** The slice of supabase-js `createClient` this file uses. */
// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; anonKey: string },
): Omit<ExportDeps, 'log'> {
  // The caller's own JWT, never the service role: RLS applies to every read.
  const asCaller = (jwt: string) =>
    createClient(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    }).schema('app');

  return {
    async ticket(jwt, exportId): Promise<Ticket | null> {
      const { data, error } = await asCaller(jwt)
        .from('data_exports')
        .select('org_id, format, expires_at')
        .eq('id', exportId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as Ticket | null;
    },
    async page(jwt, table, orgId, after, limit, columns): Promise<Row[]> {
      let query = asCaller(jwt)
        .from(table)
        .select(columns ?? '*')
        .eq(table === 'organizations' ? 'id' : 'org_id', orgId)
        .order('id')
        .limit(limit);
      if (after !== null) query = query.gt('id', after);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return data as Row[];
    },
  };
}

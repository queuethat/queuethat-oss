// 4-AI1 (#394): the Supabase side of ask-analytics, built from whichever supabase-js the runtime has.
import { type AskDeps, DbError, type LlmConfig, type ReportRow, STATUS } from './handler.ts';

// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; anonKey: string; serviceRoleKey: string },
): Pick<AskDeps, 'reserve' | 'llmConfig' | 'runReport'> {
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  // The caller's own JWT: the database applies their role and tenant to the reservation and the report.
  const asCaller = (jwt: string) =>
    createClient(env.url, env.anonKey, { ...opts, global: { headers: { Authorization: `Bearer ${jwt}` } } })
      .schema('api');
  const service = createClient(env.url, env.serviceRoleKey, opts).schema('api');
  const fail = (error: { message?: string }, what: string): never => {
    // Only the error codes the handler maps are passed on; any other database message stays out of the response.
    if (error.message && Object.hasOwn(STATUS, error.message)) throw new DbError(error.message);
    throw new Error(what);
  };
  return {
    async reserve(jwt, orgId, question) {
      const { data, error } = await asCaller(jwt).rpc('ask_analytics_reserve', {
        p_org_id: orgId,
        p_question: question,
      });
      if (error) fail(error, 'ask_analytics_reserve');
      return Number(data);
    },
    async llmConfig(orgId): Promise<LlmConfig | null> {
      const { data, error } = await service.rpc('get_channel_config', { p_org_id: orgId, p_channel: 'llm' });
      if (error) throw new Error('get_channel_config');
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.enabled || !row.provider || !row.secrets?.api_key) return null;
      return {
        provider: row.provider,
        model: typeof row.config?.model === 'string' ? row.config.model : 'claude-haiku-5-5',
        apiKey: row.secrets.api_key,
      };
    },
    async runReport(jwt, definition, from, to): Promise<ReportRow[]> {
      const { data, error } = await asCaller(jwt).rpc('run_report', {
        p_definition: definition,
        p_from: from,
        p_to: to,
      });
      if (error) fail(error, 'run_report');
      return (data as ReportRow[]).map((c) => ({ dims: c.dims ?? {}, measures: c.measures ?? {} }));
    },
  };
}

// 4-INT1 (#395, #396): the two server-side steps of connecting a CRM or POS account (square-oauth, hubspot-oauth). The vendor
// redirects the admin back to the signed-in SPA (not to this function), which posts here with the
// admin's own JWT, so the one-time state is checked against the user who started the flow (no login CSRF).
//
// POST (Authorization: Bearer <user JWT>)
//   { action: "start", org_id }           -> 200 { url }   send the admin to Square
//   { action: "finish", state, code }     -> 200 { ok: true }   tokens are in Vault, the connection is verified
//   400 invalid_input | 401 not_authenticated | 403 permission_denied | 404 not_found | 502 vendor_refused
import type { RefreshedTokens } from '@qm/providers';

export class DbError extends Error {}

export interface IntegrationOAuthDeps {
  /** The user the JWT belongs to, or null. */
  userId(jwt: string): Promise<string | null>;
  /** api.begin_integration_connect as the caller. Throws DbError with the SQL error. */
  begin(jwt: string, orgId: string): Promise<string>;
  /** The saved non-secret config, read as the caller (RLS limits it to owners and admins). */
  config(jwt: string, orgId: string): Promise<Record<string, unknown> | null>;
  /** api.consume_integration_state: org, config and secrets, or throws DbError('not_found'). */
  consume(
    state: string,
    userId: string,
  ): Promise<{ org_id: string; channel: string; provider: string; config: Record<string, unknown>; secrets: Record<string, string> }>;
  /** The connection this function serves; a state minted for another one is refused. */
  expect: { channel: string; provider: string };
  authorizeUrl(config: Record<string, unknown>, state: string): string;
  exchange(config: Record<string, unknown>, secrets: Record<string, string>, code: string): Promise<RefreshedTokens | null>;
  /** api.save_integration_tokens with p_verified = true */
  save(orgId: string, tokens: RefreshedTokens): Promise<void>;
  log?(line: string): void;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const STATUS: Record<string, number> = { invalid_input: 400, not_authenticated: 401, permission_denied: 403, not_found: 404 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function createIntegrationOAuthHandler(deps: IntegrationOAuthDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
    const uid = jwt ? await deps.userId(jwt) : null;
    if (!uid) return json(401, { error: 'not_authenticated' });

    let body: Record<string, unknown> | null = null;
    try {
      body = await req.json();
    } catch { /* falls through to invalid_input */ }

    try {
      if (body?.action === 'start' && typeof body.org_id === 'string' && UUID.test(body.org_id)) {
        const state = await deps.begin(jwt, body.org_id);
        const config = await deps.config(jwt, body.org_id);
        if (!config?.application_id) return json(400, { error: 'invalid_input' });
        return json(200, { url: deps.authorizeUrl(config, state) });
      }
      if (body?.action === 'finish' && typeof body.state === 'string' && typeof body.code === 'string'
          && body.state.length <= 200 && body.code.length <= 500) {
        const c = await deps.consume(body.state, uid);
        // A state minted for another vendor must not send that vendor's client secret here.
        if (c.channel !== deps.expect.channel || c.provider !== deps.expect.provider) return json(404, { error: 'not_found' });
        const tokens = await deps.exchange(c.config, c.secrets, body.code);
        if (!tokens) return json(502, { error: 'vendor_refused' });
        await deps.save(c.org_id, tokens);
        return json(200, { ok: true });
      }
      return json(400, { error: 'invalid_input' });
    } catch (e) {
      const code = e instanceof DbError ? Object.keys(STATUS).find((k) => e.message.includes(k)) : undefined;
      if (!code) deps.log?.('square-oauth failed');
      return json(code ? STATUS[code] : 500, { error: code ?? 'internal' });
    }
  };
}

// Turnstile on online joins (#482 follow-up). Turns a Turnstile token into a single-use join
// pass that api.join_queue spends. An Edge Function because only it holds TURNSTILE_SECRET_KEY
// and the service role, and calls Cloudflare (technical-design.md 3.5, rule 3). The join itself
// stays a direct RPC, so the database still sees the guest's own address and device.
//
// POST { token }   the token the Turnstile widget produced on the join page
//   200 { pass }                    hand it to join_queue as p_join_pass within 5 minutes
//   403 { error: "captcha_required" } missing, rejected or unverifiable token, or one solved on a
//                                     hostname the deployment doesn't list (fails closed)
//   405 { error: "invalid_input" }
//   500 { error: "unknown" }         the pass couldn't be issued

export interface JoinPassDeps {
  /** The hostname the token was solved on when Cloudflare accepted it, else null. Must not throw. */
  verify(token: string): Promise<string | null>;
  /** api.issue_join_pass, which checks `hostname`; throws HostnameRefusedError when it refuses. */
  issue(hostname: string): Promise<string>;
  error?(line: string, cause: unknown): void;
}

/** api.issue_join_pass refused the token's hostname. */
export class HostnameRefusedError extends Error {}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// Turnstile tokens are at most 2048 characters.
const MAX_TOKEN = 2048;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function createJoinPassHandler(deps: JoinPassDeps): (req: Request) => Promise<Response> {
  const error = deps.error ?? (() => {});
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });
    const body = await req.json().catch(() => null);
    const token = typeof body?.token === 'string' ? body.token : '';
    const hostname = token && token.length <= MAX_TOKEN ? await deps.verify(token) : null;
    if (hostname === null) return json(403, { error: 'captcha_required' });
    try {
      return json(200, { pass: await deps.issue(hostname) });
    } catch (failure) {
      // Not reported: anyone can embed the public site key, so this is abuse, not a fault.
      if (failure instanceof HostnameRefusedError) return json(403, { error: 'captcha_required' });
      error('join pass not issued', failure);
      return json(500, { error: 'unknown' });
    }
  };
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Checks a token with Cloudflare's siteverify and returns the hostname it was solved on. Fails
 * closed: a rejection, an error, a non-JSON answer, no hostname or no answer within 3 s all mean
 * null. Each token verifies once (Cloudflare's rule).
 */
export function turnstileVerifier(
  secret: string,
  fetchImpl: typeof fetch = fetch,
  error: (line: string, cause: unknown) => void = () => {},
): (token: string) => Promise<string | null> {
  return async (token) => {
    try {
      const response = await fetchImpl(SITEVERIFY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: token }),
        signal: AbortSignal.timeout(3000),
      });
      const answer = await response.json();
      const ok = answer?.success === true && typeof answer.hostname === 'string';
      return ok && answer.hostname !== '' ? answer.hostname : null;
    } catch (failure) {
      error('turnstile siteverify failed', failure);
      return null;
    }
  };
}

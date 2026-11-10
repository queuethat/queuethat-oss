// Square adapter (#395) over the REST API with fetch. Each org brings its own Square application
// (client id in config, client secret in Vault), so there is no platform-wide Square credential.
// A served visit upserts a Square customer by phone or email and appends a visit note to it.
import {
  cleanText,
  type IntegrationAdapter,
  type IntegrationJob,
  type RefreshedTokens,
  type SyncResult,
} from '../integration.ts';

export const SQUARE_VERSION = '2025-10-16';
const HOSTS = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
} as const;
/** Refresh when fewer than this many ms of the access token remain. */
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const SCOPES = 'CUSTOMERS_READ CUSTOMERS_WRITE';
const NOTE_MAX = 1000;
const FETCH_TIMEOUT_MS = 10_000;

type Env = keyof typeof HOSTS;
const host = (config: Record<string, unknown>) =>
  HOSTS[config.environment === 'sandbox' ? 'sandbox' : ('production' as Env)];

export interface SquareOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** The URL an admin is sent to; `state` comes from api.begin_integration_connect. */
export function squareAuthorizeUrl(config: Record<string, unknown>, state: string): string {
  const q = new URLSearchParams({
    client_id: String(config.application_id ?? ''),
    scope: SCOPES,
    session: 'false',
    state,
  });
  return `${host(config)}/oauth2/authorize?${q}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id?: string;
}

async function token(
  f: typeof fetch,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  grant: Record<string, string>,
): Promise<RefreshedTokens | null> {
  const res = await f(`${host(config)}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
    body: JSON.stringify({
      client_id: config.application_id,
      client_secret: secrets.application_secret,
      ...grant,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) return null;
  return {
    secrets: {
      access_token: body.access_token,
      ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    },
    config: {
      ...(body.merchant_id ? { merchant_id: body.merchant_id } : {}),
      ...(body.expires_at ? { expires_at: body.expires_at } : {}),
    },
  };
}

/** Trades the one-time code from the redirect for tokens; null when Square refuses it. */
export function squareExchangeCode(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  code: string,
  opts: SquareOptions = {},
): Promise<RefreshedTokens | null> {
  return token(opts.fetch ?? fetch, config, secrets, { grant_type: 'authorization_code', code });
}

interface Customer {
  id: string;
  note?: string;
}

function visitNote(job: IntegrationJob): string {
  const day = (job.visit.finished_at ?? '').slice(0, 10);
  const marker = `qt:${job.id.slice(0, 8)}`;
  return `Served from ${cleanText(job.visit.queue, 60)} (${cleanText(job.visit.ticket, 12)}) ${day} [${marker}]`;
}

export function squareAdapter(opts: SquareOptions = {}): IntegrationAdapter {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());

  return {
    provider: 'square',
    async sync(job): Promise<SyncResult> {
      let refreshed: RefreshedTokens | undefined;
      let access = job.secrets.access_token;
      if (!access) return { status: 'failed', error: 'not_connected', retryable: false };

      const expires = Date.parse(String(job.config.expires_at ?? ''));
      if (
        Number.isFinite(expires) &&
        expires - now() < REFRESH_WINDOW_MS &&
        job.secrets.refresh_token
      ) {
        const next = await token(f, job.config, job.secrets, {
          grant_type: 'refresh_token',
          refresh_token: job.secrets.refresh_token,
        });
        if (!next) return { status: 'failed', error: 'refresh_failed', retryable: true };
        refreshed = next;
        access = next.secrets.access_token;
      }

      const base = host(job.config);
      const call = async (
        method: string,
        path: string,
        body: unknown,
      ): Promise<{ status: number; json: unknown }> => {
        const res = await f(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${access}`,
            'Content-Type': 'application/json',
            'Square-Version': SQUARE_VERSION,
          },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        return { status: res.status, json: res.ok ? await res.json() : null };
      };
      const fail = (status: number): SyncResult => ({
        status: 'failed',
        error: status === 401 || status === 403 ? 'unauthorized' : `http_${status}`,
        retryable: !(status === 400 || status === 401 || status === 403 || status === 404),
        refreshed,
      });

      const filter =
        job.contact.channel === 'phone'
          ? { phone_number: { exact: job.contact.value } }
          : { email_address: { exact: job.contact.value } };
      const found = await call('POST', '/v2/customers/search', { query: { filter }, limit: 1 });
      if (found.status !== 200) return fail(found.status);
      let customer = ((found.json as { customers?: Customer[] }).customers ?? [])[0];

      const note = visitNote(job);
      if (!customer) {
        const created = await call('POST', '/v2/customers', {
          idempotency_key: job.id,
          given_name: cleanText(job.contact.name, 60) || undefined,
          ...(job.contact.channel === 'phone'
            ? { phone_number: job.contact.value }
            : { email_address: job.contact.value }),
          note,
        });
        if (created.status !== 200) return fail(created.status);
        return { status: 'delivered', refreshed };
      }

      customer = { ...customer, note: customer.note ?? '' };
      // A retry after a lost response must not add the same line twice.
      if (customer.note!.includes(`[qt:${job.id.slice(0, 8)}]`))
        return { status: 'delivered', refreshed };
      const merged = `${customer.note}${customer.note ? '\n' : ''}${note}`;
      // Keep the newest lines when the note would overflow.
      const trimmed =
        merged.length > NOTE_MAX
          ? merged.slice(merged.length - NOTE_MAX).replace(/^[^\n]*\n/, '')
          : merged;
      const updated = await call('PUT', `/v2/customers/${encodeURIComponent(customer.id)}`, {
        note: trimmed,
      });
      return updated.status === 200 ? { status: 'delivered', refreshed } : fail(updated.status);
    },
  };
}

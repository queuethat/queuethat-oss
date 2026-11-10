// HubSpot adapter (#396) over the REST API with fetch. Each org brings its own HubSpot app (client id in config,
// client secret in Vault). A served visit upserts a contact by email or phone and adds a note to its timeline.
import {
  cleanText,
  type IntegrationAdapter,
  type IntegrationJob,
  type RefreshedTokens,
  type SyncResult,
} from '../integration.ts';

const API = 'https://api.hubapi.com';
const AUTHORIZE = 'https://app.hubspot.com/oauth/authorize';
const SCOPES = 'crm.objects.contacts.read crm.objects.contacts.write';
/** HubSpot-defined association type: note to contact. */
const NOTE_TO_CONTACT = 202;
const REFRESH_WINDOW_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface HubSpotOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** The URL an admin is sent to; `state` comes from api.begin_integration_connect. HubSpot requires redirect_uri in config. */
export function hubspotAuthorizeUrl(config: Record<string, unknown>, state: string): string {
  const q = new URLSearchParams({
    client_id: String(config.application_id ?? ''),
    redirect_uri: String(config.redirect_uri ?? ''),
    scope: SCOPES,
    state,
  });
  return `${AUTHORIZE}?${q}`;
}

async function token(
  f: typeof fetch,
  now: number,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  grant: Record<string, string>,
): Promise<RefreshedTokens | null> {
  const res = await f(`${API}/oauth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: String(config.application_id ?? ''),
      client_secret: secrets.application_secret ?? '',
      redirect_uri: String(config.redirect_uri ?? ''),
      ...grant,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) return null;
  return {
    secrets: {
      access_token: body.access_token,
      ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    },
    config:
      typeof body.expires_in === 'number'
        ? { expires_at: new Date(now + body.expires_in * 1000).toISOString() }
        : {},
  };
}

/** Trades the one-time code from the redirect for tokens; null when HubSpot refuses it. */
export function hubspotExchangeCode(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  code: string,
  opts: HubSpotOptions = {},
): Promise<RefreshedTokens | null> {
  return token(opts.fetch ?? fetch, (opts.now ?? Date.now)(), config, secrets, {
    grant_type: 'authorization_code',
    code,
  });
}

export function hubspotAdapter(opts: HubSpotOptions = {}): IntegrationAdapter {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;

  return {
    provider: 'hubspot',
    async sync(job: IntegrationJob): Promise<SyncResult> {
      let refreshed: RefreshedTokens | undefined;
      let access = job.secrets.access_token;
      if (!access) return { status: 'failed', error: 'not_connected', retryable: false };

      const expires = Date.parse(String(job.config.expires_at ?? ''));
      if (
        Number.isFinite(expires) &&
        expires - now() < REFRESH_WINDOW_MS &&
        job.secrets.refresh_token
      ) {
        const next = await token(f, now(), job.config, job.secrets, {
          grant_type: 'refresh_token',
          refresh_token: job.secrets.refresh_token,
        });
        if (!next) return { status: 'failed', error: 'refresh_failed', retryable: true };
        refreshed = next;
        access = next.secrets.access_token;
      }

      const call = async (
        path: string,
        body: unknown,
      ): Promise<{ status: number; json: unknown }> => {
        const res = await f(`${API}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
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
      const done: SyncResult = { status: 'delivered', refreshed };
      const results = (r: { json: unknown }) =>
        (r.json as { results?: Array<{ id: string }> } | null)?.results ?? [];

      const prop = job.contact.channel === 'phone' ? 'phone' : 'email';
      const found = await call('/crm/v3/objects/contacts/search', {
        filterGroups: [
          { filters: [{ propertyName: prop, operator: 'EQ', value: job.contact.value }] },
        ],
        properties: [prop],
        limit: 1,
      });
      if (found.status !== 200) return fail(found.status);
      let contactId: string | undefined = results(found)[0]?.id;
      if (!contactId) {
        const name = cleanText(job.contact.name, 60);
        const created = await call('/crm/v3/objects/contacts', {
          properties: { [prop]: job.contact.value, ...(name ? { firstname: name } : {}) },
        });
        // 409: another sync created it first; the retry finds it.
        if (created.status !== 201 && created.status !== 200) return fail(created.status);
        contactId = (created.json as { id?: string } | null)?.id;
        if (!contactId)
          return { status: 'failed', error: 'bad_response', retryable: true, refreshed };
      }

      // Notes have no idempotency key: a one-word marker lets a retry after a lost response see its own note.
      const marker = `qt${job.id.replaceAll('-', '').slice(0, 8)}`;
      const seen = await call('/crm/v3/objects/notes/search', {
        filterGroups: [
          {
            filters: [{ propertyName: 'hs_note_body', operator: 'CONTAINS_TOKEN', value: marker }],
          },
        ],
        limit: 1,
      });
      if (seen.status !== 200) return fail(seen.status);
      if (results(seen).length > 0) return done;

      const when = job.visit.finished_at ?? new Date(now()).toISOString();
      const note = await call('/crm/v3/objects/notes', {
        properties: {
          hs_timestamp: when,
          hs_note_body: `Served from ${cleanText(job.visit.queue, 60)} (${cleanText(job.visit.ticket, 12)}) ${marker}`,
        },
        associations: [
          {
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }],
          },
        ],
      });
      return note.status === 201 || note.status === 200 ? done : fail(note.status);
    },
  };
}

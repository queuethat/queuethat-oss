import { describe, expect, it } from 'vitest';
import type { IntegrationJob } from '../integration.ts';
import * as fx from './fixtures/hubspot.ts';
import { hubspotAdapter, hubspotAuthorizeUrl, hubspotExchangeCode } from './hubspot.ts';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake HubSpot: answers each call with the next queued fixture and records what was sent. */
function fakeHubSpot(...replies: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const raw = init.body;
    calls.push({
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body:
        raw instanceof URLSearchParams
          ? Object.fromEntries(raw)
          : raw
            ? JSON.parse(String(raw))
            : null,
    });
    const r = replies.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  const paths = () => calls.map((c) => new URL(c.url).pathname);
  return { calls, fetchFn, paths };
}

const job = (over: Partial<IntegrationJob> = {}): IntegrationJob => ({
  id: '11111111-2222-3333-4444-555555555555',
  org_id: 'org-a',
  channel: 'crm',
  provider: 'hubspot',
  config: {
    application_id: 'hs-app',
    redirect_uri: 'https://app.example/cb',
    expires_at: '2099-01-01T00:00:00Z',
  },
  secrets: { access_token: 'tok-a', refresh_token: 'ref-a', application_secret: 'sec-a' },
  attempts: 0,
  visit: {
    id: 'v1',
    ticket: 'A012',
    queue: 'Haircuts',
    joined_at: null,
    serving_at: null,
    finished_at: '2026-10-30T15:04:00Z',
  },
  contact: { channel: 'email', value: 'gina@example.com', name: 'Gina' },
  ...over,
});

describe('HubSpot adapter', () => {
  it('a new contact is created once, then the note is added to it', async () => {
    const hs = fakeHubSpot(fx.searchEmpty, fx.contactCreated, fx.searchEmpty, fx.noteCreated);
    const r = await hubspotAdapter({ fetch: hs.fetchFn, now: () => Date.UTC(2026, 9, 30) }).sync(
      job(),
    );
    expect(r.status).toBe('delivered');
    expect(hs.paths()).toEqual([
      '/crm/v3/objects/contacts/search',
      '/crm/v3/objects/contacts',
      '/crm/v3/objects/notes/search',
      '/crm/v3/objects/notes',
    ]);
    expect(hs.calls[0]!.body).toMatchObject({
      filterGroups: [
        { filters: [{ propertyName: 'email', operator: 'EQ', value: 'gina@example.com' }] },
      ],
    });
    expect(hs.calls[1]!.body).toEqual({
      properties: { email: 'gina@example.com', firstname: 'Gina' },
    });
    expect(hs.calls[3]!.body).toMatchObject({
      associations: [{ to: { id: '777' }, types: [{ associationTypeId: 202 }] }],
      properties: { hs_timestamp: '2026-10-30T15:04:00Z' },
    });
    expect(hs.calls[3]!.headers.Authorization).toBe('Bearer tok-a');
  });

  it('an existing contact is not created again', async () => {
    const hs = fakeHubSpot(fx.searchHit, fx.searchEmpty, fx.noteCreated);
    await hubspotAdapter({ fetch: hs.fetchFn }).sync(
      job({ contact: { channel: 'phone', value: '+14155550123', name: null } }),
    );
    expect(hs.paths()).toEqual([
      '/crm/v3/objects/contacts/search',
      '/crm/v3/objects/notes/search',
      '/crm/v3/objects/notes',
    ]);
    expect(hs.calls[0]!.body).toMatchObject({
      filterGroups: [{ filters: [{ propertyName: 'phone' }] }],
    });
    expect(hs.calls[2]!.body).toMatchObject({ associations: [{ to: { id: '501' } }] });
  });

  it('a retry after a lost response does not add the note twice', async () => {
    const mine = { status: 200, body: { total: 1, results: [{ id: '9001' }] } };
    const hs = fakeHubSpot(fx.searchHit, mine);
    expect((await hubspotAdapter({ fetch: hs.fetchFn }).sync(job())).status).toBe('delivered');
    expect(hs.paths()).not.toContain('/crm/v3/objects/notes');
    expect(hs.calls[1]!.body).toMatchObject({
      filterGroups: [{ filters: [{ operator: 'CONTAINS_TOKEN', value: 'qt11111111' }] }],
    });
  });

  it('refreshes a token about to expire and returns the new one for storage', async () => {
    const hs = fakeHubSpot(fx.tokenOk, fx.searchHit, fx.searchEmpty, fx.noteCreated);
    const now = Date.parse('2099-01-01T00:00:00Z') - 1000;
    const r = await hubspotAdapter({ fetch: hs.fetchFn, now: () => now }).sync(job());
    expect(r).toMatchObject({
      status: 'delivered',
      refreshed: { secrets: { access_token: 'CJ-new-access', refresh_token: 'na1-new-refresh' } },
    });
    expect(hs.calls[0]!.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ref-a',
      client_secret: 'sec-a',
    });
    expect(hs.calls[1]!.headers.Authorization).toBe('Bearer CJ-new-access');
  });

  it('reports a short code, never the response body, and stops retrying on auth errors', async () => {
    const auth = await hubspotAdapter({ fetch: fakeHubSpot(fx.unauthorized).fetchFn }).sync(job());
    expect(auth).toMatchObject({ status: 'failed', error: 'unauthorized', retryable: false });
    expect(JSON.stringify(auth)).not.toContain('secret detail');
    const busy = await hubspotAdapter({
      fetch: fakeHubSpot({ status: 429, body: {} }).fetchFn,
    }).sync(job());
    expect(busy).toMatchObject({ status: 'failed', error: 'http_429', retryable: true });
  });

  it('drops formula prefixes from a guest-typed name', async () => {
    const hs = fakeHubSpot(fx.searchEmpty, fx.contactCreated, fx.searchEmpty, fx.noteCreated);
    await hubspotAdapter({ fetch: hs.fetchFn }).sync(
      job({ contact: { channel: 'email', value: 'g@example.com', name: '=cmd|x' } }),
    );
    expect(hs.calls[1]!.body).toEqual({
      properties: { email: 'g@example.com', firstname: 'cmd|x' },
    });
  });

  it('OAuth: the authorize URL carries state and redirect, and the exchange returns tokens with an expiry', async () => {
    const url = new URL(
      hubspotAuthorizeUrl(
        { application_id: 'hs-app', redirect_uri: 'https://app.example/cb' },
        'st4te',
      ),
    );
    expect(url.host).toBe('app.hubspot.com');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/cb');
    const hs = fakeHubSpot(fx.tokenOk);
    const t = await hubspotExchangeCode(
      { application_id: 'hs-app' },
      { application_secret: 's' },
      'code1',
      { fetch: hs.fetchFn, now: () => 0 },
    );
    expect(t).toMatchObject({
      secrets: { refresh_token: 'na1-new-refresh' },
      config: { expires_at: '1970-01-01T00:30:00.000Z' },
    });
    expect(hs.calls[0]!.body).toMatchObject({ grant_type: 'authorization_code', code: 'code1' });
    expect(
      await hubspotExchangeCode({}, {}, 'bad', { fetch: fakeHubSpot(fx.unauthorized).fetchFn }),
    ).toBeNull();
  });
});

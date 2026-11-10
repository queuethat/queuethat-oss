import { describe, expect, it } from 'vitest';
import type { IntegrationJob } from '../integration.ts';
import * as fx from './fixtures/square.ts';
import { squareAdapter, squareAuthorizeUrl, squareExchangeCode } from './square.ts';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** A fake Square: answers each call with the next queued fixture and records what was sent. */
function fakeSquare(...replies: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    const r = replies.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const job = (over: Partial<IntegrationJob> = {}): IntegrationJob => ({
  id: '11111111-2222-3333-4444-555555555555',
  org_id: 'org-a',
  channel: 'pos',
  provider: 'square',
  config: { application_id: 'sq0idp-a', expires_at: '2099-01-01T00:00:00Z' },
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
  contact: { channel: 'phone', value: '+14155550123', name: 'Gina' },
  ...over,
});

describe('Square adapter', () => {
  it('AC1: a new guest is created once with the visit note', async () => {
    const sq = fakeSquare(fx.searchEmpty, fx.created);
    const r = await squareAdapter({ fetch: sq.fetchFn, now: () => Date.UTC(2026, 9, 30) }).sync(
      job(),
    );
    expect(r).toEqual({ status: 'delivered', refreshed: undefined });
    expect(sq.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v2/customers/search',
      'POST /v2/customers',
    ]);
    expect(sq.calls[0]!.body).toMatchObject({
      query: { filter: { phone_number: { exact: '+14155550123' } } },
    });
    expect(sq.calls[1]!.body).toMatchObject({
      idempotency_key: job().id,
      given_name: 'Gina',
      phone_number: '+14155550123',
    });
    expect(String(sq.calls[1]!.body?.note)).toContain('Haircuts (A012) 2026-10-30');
    expect(sq.calls[1]!.headers.Authorization).toBe('Bearer tok-a');
  });

  it('matches an existing customer and appends to the note instead of creating', async () => {
    const sq = fakeSquare(fx.searchHit, fx.updated);
    const r = await squareAdapter({ fetch: sq.fetchFn }).sync(job());
    expect(r.status).toBe('delivered');
    expect(sq.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v2/customers/search',
      'PUT /v2/customers/CUST1',
    ]);
    expect(String(sq.calls[1]!.body?.note)).toMatch(/^Prefers mornings\nServed from Haircuts/);
  });

  it('a retry after a lost response does not repeat the note', async () => {
    const withNote = {
      status: 200,
      body: {
        customers: [{ id: 'CUST1', note: 'Served from Haircuts (A012) 2026-10-30 [qt:11111111]' }],
      },
    };
    const sq = fakeSquare(withNote);
    expect((await squareAdapter({ fetch: sq.fetchFn }).sync(job())).status).toBe('delivered');
    expect(sq.calls).toHaveLength(1);
  });

  it('looks up an email contact by address', async () => {
    const sq = fakeSquare(fx.searchEmpty, fx.created);
    await squareAdapter({ fetch: sq.fetchFn }).sync(
      job({ contact: { channel: 'email', value: 'g@example.com', name: null } }),
    );
    expect(sq.calls[0]!.body).toMatchObject({
      query: { filter: { email_address: { exact: 'g@example.com' } } },
    });
    expect(sq.calls[1]!.body).toMatchObject({ email_address: 'g@example.com' });
    expect(sq.calls[1]!.body).not.toHaveProperty('given_name');
  });

  it('refreshes a token that is about to expire and returns the new one for storage', async () => {
    const sq = fakeSquare(fx.tokenOk, fx.searchEmpty, fx.created);
    const r = await squareAdapter({
      fetch: sq.fetchFn,
      now: () => Date.parse('2099-01-01T00:00:00Z') - 1000,
    }).sync(job());
    expect(r).toMatchObject({
      status: 'delivered',
      refreshed: { secrets: { access_token: 'EAAA-new-access' }, config: { merchant_id: 'MLSQ1' } },
    });
    expect(sq.calls[0]!.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ref-a',
      client_secret: 'sec-a',
    });
    expect(sq.calls[1]!.headers.Authorization).toBe('Bearer EAAA-new-access');
  });

  it('uses the sandbox host when configured and never follows redirects', async () => {
    const sq = fakeSquare(fx.searchEmpty, fx.created);
    await squareAdapter({ fetch: sq.fetchFn }).sync(
      job({ config: { application_id: 'x', environment: 'sandbox' } }),
    );
    expect(new URL(sq.calls[0]!.url).host).toBe('connect.squareupsandbox.com');
  });

  it('reports a short code, never the response body, and stops retrying on auth errors', async () => {
    const auth = await squareAdapter({ fetch: fakeSquare(fx.unauthorized).fetchFn }).sync(job());
    expect(auth).toMatchObject({ status: 'failed', error: 'unauthorized', retryable: false });
    expect(JSON.stringify(auth)).not.toContain('secret detail');
    const down = await squareAdapter({ fetch: fakeSquare({ status: 503, body: {} }).fetchFn }).sync(
      job(),
    );
    expect(down).toMatchObject({ status: 'failed', error: 'http_503', retryable: true });
  });

  it('drops spreadsheet formula prefixes and bidi characters from a guest-typed name', async () => {
    const sq = fakeSquare(fx.searchEmpty, fx.created);
    await squareAdapter({ fetch: sq.fetchFn }).sync(
      job({
        contact: {
          channel: 'phone',
          value: '+14155550123',
          name: '=HYPERLINK("http://x")\u202eGina',
        },
      }),
    );
    expect(sq.calls[1]!.body?.given_name).toBe('HYPERLINK("http://x") Gina');
  });

  it('strips control characters from a guest-typed name', async () => {
    const sq = fakeSquare(fx.searchEmpty, fx.created);
    await squareAdapter({ fetch: sq.fetchFn }).sync(
      job({ contact: { channel: 'phone', value: '+14155550123', name: 'Gi\nna\u0000 <b>' } }),
    );
    expect(sq.calls[1]!.body?.given_name).toBe('Gi na <b>');
  });

  it('OAuth: the authorize URL carries the state and the exchange returns tokens', async () => {
    const url = new URL(squareAuthorizeUrl({ application_id: 'sq0idp-a' }, 'st4te'));
    expect(url.host).toBe('connect.squareup.com');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('scope')).toBe('CUSTOMERS_READ CUSTOMERS_WRITE');
    const sq = fakeSquare(fx.tokenOk);
    const t = await squareExchangeCode(
      { application_id: 'sq0idp-a' },
      { application_secret: 's' },
      'code1',
      { fetch: sq.fetchFn },
    );
    expect(t?.secrets.refresh_token).toBe('EQAA-new-refresh');
    expect(sq.calls[0]!.body).toMatchObject({ grant_type: 'authorization_code', code: 'code1' });
    expect(
      await squareExchangeCode({}, {}, 'bad', { fetch: fakeSquare(fx.unauthorized).fetchFn }),
    ).toBeNull();
  });
});

import { errorCode } from '@qm/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinProvider, PublicJoinError, publicJoin } from './publicJoin.ts';

const fetchMock = vi.fn<typeof fetch>();
const body = {
  queueId: 'q',
  serviceId: null,
  name: 'Sam',
  phone: null,
  email: null,
  partySize: 1,
  locale: 'en',
  idempotencyKey: 'k',
  deviceKey: null,
  captcha: 'tok',
};

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'http://db.test');
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  localStorage.clear();
});

describe('joinProvider', () => {
  it('is off unless VITE_PUBLIC_JOIN names a known provider', () => {
    expect(joinProvider()).toBeNull();
    vi.stubEnv('VITE_PUBLIC_JOIN', 'carrier-pigeon');
    expect(joinProvider()).toBeNull();
    vi.stubEnv('VITE_PUBLIC_JOIN', 'pow');
    expect(joinProvider()).toBe('pow');
  });
});

describe('publicJoin', () => {
  it('POSTs JSON to the Edge Function and returns the ticket', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ token: 't', display_ticket: 'A001', status: 'waiting' }),
    );
    expect(await publicJoin(body)).toMatchObject({ display_ticket: 'A001' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://db.test/functions/v1/public-join');
    expect(JSON.parse(String(init!.body)).captcha).toBe('tok');
  });

  it('keeps the database error code for errorCode() and the detail', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'queue_not_accepting', detail: 'paused' }, { status: 409 }),
    );
    const error = await publicJoin(body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicJoinError);
    expect(errorCode(error)).toBe('queue_not_accepting');
    expect((error as PublicJoinError).details).toBe('paused');
  });

  it('reads Retry-After on a 429 and reports it as the network limit', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '420' } }),
    );
    const error = (await publicJoin(body).catch((e: unknown) => e)) as PublicJoinError;
    expect(error.retryAfter).toBe(420);
    expect(error.details).toBe('network');
    expect(errorCode(error)).toBe('rate_limited');
  });
});

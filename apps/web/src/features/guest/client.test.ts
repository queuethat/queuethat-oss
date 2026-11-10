import { errorCode } from '@qm/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guestFunction, guestRpc } from './client.ts';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'http://db.test');
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('guestRpc', () => {
  it('POSTs to the api schema with a publishable key and no Authorization header', async () => {
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_x');
    fetchMock.mockResolvedValue(Response.json({ token: 't' }));
    await guestRpc('get_visit_status', { p_token: 't' });
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(url).toBe('http://db.test/rest/v1/rpc/get_visit_status');
    expect(init!.method).toBe('POST');
    expect(headers['Content-Profile']).toBe('api');
    expect(headers.apikey).toBe('sb_publishable_x');
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends a legacy JWT anon key as a bearer token too', async () => {
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'eyJhbGciOi.x.y');
    fetchMock.mockResolvedValue(Response.json({}));
    await guestRpc('get_location_public', { p_location_slug: 'x' });
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer eyJhbGciOi.x.y');
  });

  it('rejects with an error that errorCode() maps', async () => {
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_x');
    fetchMock.mockResolvedValue(
      Response.json(
        { code: 'P0001', message: 'queue_not_accepting', details: 'paused' },
        { status: 400 },
      ),
    );
    const error = await guestRpc('get_location_public', { p_location_slug: 'x' }).catch(
      (e: unknown) => e,
    );
    expect(errorCode(error)).toBe('queue_not_accepting');
    expect((error as { details: string }).details).toBe('paused');
  });

  it("maps the gateway's 429, which has no database code, to rate_limited", async () => {
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_x');
    fetchMock.mockResolvedValue(
      Response.json({ message: 'API rate limit exceeded' }, { status: 429 }),
    );
    const error = await guestRpc('join_queue', {} as never).catch((e: unknown) => e);
    expect(errorCode(error)).toBe('rate_limited');
    expect((error as { status: number }).status).toBe(429);
  });

  it('maps an HTML 429 from a CDN rule to rate_limited too', async () => {
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_x');
    fetchMock.mockResolvedValue(new Response('<html>429</html>', { status: 429 }));
    const error = await guestRpc('join_queue', {} as never).catch((e: unknown) => e);
    expect(errorCode(error)).toBe('rate_limited');
  });
});

describe('guestFunction', () => {
  it("maps the gateway's 429 on join-pass to rate_limited", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ message: 'API rate limit exceeded' }, { status: 429 }),
    );
    const error = await guestFunction('join-pass', { token: 't' }).catch((e: unknown) => e);
    expect(errorCode(error)).toBe('rate_limited');
  });

  it("keeps the function's own error code", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'captcha_required' }, { status: 403 }));
    const error = await guestFunction('join-pass', { token: 't' }).catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe('captcha_required');
  });
});

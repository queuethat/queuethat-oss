import { describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
vi.mock('./realtime.ts', () => ({
  setRealtimeAuth: (token: string | null) => calls.push(`auth:${token}`),
  joinTopic: (topic: string) => {
    calls.push(`join:${topic}`);
    return () => {};
  },
}));

describe('setLiveAuth', () => {
  it('authorizes the socket before the first private join, then follows refresh and sign-out', async () => {
    const { realtimeSource, setLiveAuth } = await import('./live.ts');
    setLiveAuth('jwt-1');
    realtimeSource(
      'loc:1',
      () => {},
      () => {},
    );
    await vi.waitFor(() => expect(calls).toContain('join:loc:1'));
    expect(calls).toEqual(['auth:jwt-1', 'join:loc:1']);

    setLiveAuth('jwt-2');
    setLiveAuth(null);
    expect(calls.slice(2)).toEqual(['auth:jwt-2', 'auth:null']);
  });
});

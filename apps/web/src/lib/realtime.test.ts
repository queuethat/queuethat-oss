import { afterEach, describe, expect, it, vi } from 'vitest';

const channel = vi.fn();
const hooks: {
  heartbeat?: (status: string) => void;
  subscribe: Map<string, (status: string) => void>;
} = { subscribe: new Map() };
vi.mock('@supabase/realtime-js', () => ({
  RealtimeClient: class {
    constructor(_url: string, options: { heartbeatCallback?: (status: string) => void }) {
      hooks.heartbeat = options.heartbeatCallback;
    }
    channel(topic: string, options: unknown) {
      channel(topic, options);
      const ch = {
        on: () => ch,
        subscribe: (cb: (status: string) => void) => {
          hooks.subscribe.set(topic, cb);
          return ch;
        },
      };
      return ch;
    }
    removeChannel() {}
    setAuth() {}
  },
}));

afterEach(() => vi.unstubAllEnvs());

describe('joinTopic', () => {
  // V9 security review: pulses are sent privately and any public subscriber could forge them.
  it.each(['qpulse:abc', 'loc:123'])('joins %s as a private channel', async (topic) => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://db.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test');
    const { joinTopic } = await import('./realtime.ts');
    joinTopic(
      topic,
      () => {},
      () => {},
    )();
    expect(channel).toHaveBeenCalledWith(
      topic,
      expect.objectContaining({ config: expect.objectContaining({ private: true }) }),
    );
  });
});

describe('a socket that stops answering', () => {
  afterEach(() => vi.useRealTimers());

  // #529: realtime-js alone took about 50 s to notice; the TV kept saying it was live.
  it('reports offline when a heartbeat goes unanswered, and live again once one is answered', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_SUPABASE_URL', 'http://db.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test');
    const { joinTopic, HEARTBEAT_GRACE_MS } = await import('./realtime.ts');
    const states: string[] = [];
    const leave = joinTopic(
      'loc:stale',
      () => {},
      (s) => states.push(s),
    );
    hooks.subscribe.get('loc:stale')?.('SUBSCRIBED');
    expect(states.at(-1)).toBe('live');

    hooks.heartbeat?.('sent');
    hooks.heartbeat?.('ok');
    vi.advanceTimersByTime(HEARTBEAT_GRACE_MS);
    expect(states.at(-1)).toBe('live');

    hooks.heartbeat?.('sent');
    vi.advanceTimersByTime(HEARTBEAT_GRACE_MS);
    expect(states.at(-1)).toBe('offline');

    hooks.heartbeat?.('ok');
    expect(states.at(-1)).toBe('live');
    leave();
  });
});

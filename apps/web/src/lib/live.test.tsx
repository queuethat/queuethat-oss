import type { ConnectionState } from '@qm/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatAsOf,
  isStale,
  liveDrops,
  POLL_MS,
  useConnectionState,
  useLiveQuery,
  type Pulse,
  type PulseSource,
} from './live.ts';

/** A channel the test drives by hand. */
function fakeSource() {
  let pulse: (p: Pulse) => void = () => {};
  let state: (s: ConnectionState) => void = () => {};
  const source: PulseSource = (_topic, onPulse, onState) => {
    pulse = onPulse;
    state = onState;
    onState('connecting');
    return () => {};
  };
  return { source, send: (p: Pulse) => pulse(p), setState: (s: ConnectionState) => state(s) };
}

function setup(
  versionOf?: (data: { version: number }) => number,
  pollMs?: (data: { version: number } | undefined) => number,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  let version = 5;
  const queryFn = vi.fn(async () => ({ version }));
  const channel = fakeSource();
  const hook = renderHook(
    () =>
      useLiveQuery({
        topic: 'qpulse:abc',
        queryKey: ['visit'],
        queryFn,
        versionOf,
        pollMs,
        source: channel.source,
      }),
    { wrapper },
  );
  return { hook, queryFn, channel, bump: (v: number) => (version = v) };
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

describe('useLiveQuery', () => {
  it('refetches by polling after 30 s when the socket has dropped (AC1)', async () => {
    const { queryFn, channel } = setup();
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);
    act(() => channel.setState('offline'));
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('polls at the interval the data asks for (#548: the guest who is next)', async () => {
    const { queryFn, bump } = setup(undefined, (d) => (d && d.version >= 6 ? 5_000 : POLL_MS));
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(queryFn).toHaveBeenCalledTimes(1);
    bump(6);
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS - 5_000));
    expect(queryFn).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('ignores a pulse older than the cached version (AC2)', async () => {
    const { queryFn, channel } = setup((d) => d.version);
    await settle();
    act(() => channel.send({ version: 4 }));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('catches up once when the channel joins after the first fetch, and again on reconnect', async () => {
    const { queryFn, channel, bump } = setup((d) => d.version);
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);

    // A change committed while the channel was still joining was never pulsed.
    bump(6);
    act(() => channel.setState('live'));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(queryFn).toHaveBeenCalledTimes(2);

    act(() => channel.setState('live'));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(queryFn).toHaveBeenCalledTimes(2);

    act(() => channel.setState('offline'));
    act(() => channel.setState('live'));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('refetches on a pulse equal to the cached version', async () => {
    const { queryFn, channel } = setup((d) => d.version);
    await settle();
    act(() => channel.send({ version: 5 }));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('refetches once, within the jitter window, for a burst of newer pulses', async () => {
    const { queryFn, channel, bump } = setup((d) => d.version);
    await settle();
    bump(7);
    act(() => {
      channel.send({ version: 6 });
      channel.send({ version: 7 });
    });
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  // A staff console shares one `loc:` topic with every tablet at the location. When pulses come
  // faster than a refetch takes, each pulse used to cancel the refetch in flight, so no answer
  // ever landed and the list froze (the day-in-the-shop flake).
  it('shows data while pulses keep arriving faster than a refetch takes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    let version = 1;
    const queryFn = vi.fn(async () => {
      const seen = version;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { version: seen };
    });
    const channel = fakeSource();
    const { result } = renderHook(
      () =>
        useLiveQuery({
          topic: 'loc:abc',
          queryKey: ['storm'],
          queryFn,
          jitterMs: 0,
          source: channel.source,
        }),
      { wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(result.current.data).toEqual({ version: 1 });

    for (let i = 0; i < 30; i++) {
      version++;
      act(() => channel.send({ version }));
      await act(() => vi.advanceTimersByTimeAsync(30));
    }
    // Answers landed during the storm, not only after it.
    expect(result.current.data!.version).toBeGreaterThan(1);

    // And after the last pulse the list catches up to the last change.
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(result.current.data).toEqual({ version });
  });

  it('refetches again when a pulse joins a poll already in flight', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    let version = 1;
    const queryFn = vi.fn(async () => {
      const seen = version;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { version: seen };
    });
    const channel = fakeSource();
    const { result } = renderHook(
      () =>
        useLiveQuery({
          topic: 'loc:abc',
          queryKey: ['joined'],
          queryFn,
          jitterMs: 0,
          source: channel.source,
        }),
      { wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(150));
    // The poll starts at about 30.1 s and takes 100 ms; the change and its pulse land during it.
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    version = 2;
    act(() => channel.send({ version }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(result.current.data).toEqual({ version: 2 });
  });

  it('follows several topics with one refetch, and leaves them all on unmount', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const pulses = new Map<string, (p: Pulse) => void>();
    const left: string[] = [];
    const source: PulseSource = (topic, onPulse) => {
      pulses.set(topic, onPulse);
      return () => left.push(topic);
    };
    const queryFn = vi.fn(async () => ['a', 'b']);
    const hook = renderHook(
      () =>
        useLiveQuery({
          topic: (ids) => ids?.map((id) => `qpulse:${id}`),
          queryKey: ['location'],
          queryFn,
          source,
        }),
      { wrapper },
    );
    await settle();
    expect([...pulses.keys()]).toEqual(['qpulse:a', 'qpulse:b']);

    act(() => {
      pulses.get('qpulse:a')!({ version: 1 });
      pulses.get('qpulse:b')!({ version: 1 });
    });
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(queryFn).toHaveBeenCalledTimes(2);

    hook.unmount();
    expect(left.sort()).toEqual(['qpulse:a', 'qpulse:b']);
  });

  it('refetches on every pulse when the data carries no queue version', async () => {
    const { queryFn, channel } = setup();
    await settle();
    act(() => channel.send({ version: 1 }));
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});

describe('useConnectionState', () => {
  it('reports the channel state, and offline when the browser is offline', async () => {
    const { channel } = setup();
    let seen: ConnectionState | undefined;
    function Probe() {
      seen = useConnectionState();
      return null;
    }
    render(<Probe />);
    expect(seen).toBe('connecting');
    act(() => channel.setState('live'));
    expect(seen).toBe('live');

    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(seen).toBe('offline');
    online.mockRestore();
  });
});

describe('liveDrops', () => {
  it('counts a live topic dropping, not the first connect, and keeps what was not acked', () => {
    liveDrops.ack(liveDrops.count());
    const { channel } = setup();
    expect(liveDrops.count()).toBe(0);
    act(() => channel.setState('live'));
    act(() => channel.setState('connecting'));
    act(() => channel.setState('offline'));
    act(() => channel.setState('live'));
    act(() => channel.setState('offline'));
    expect(liveDrops.count()).toBe(2);
    liveDrops.ack(1);
    expect(liveDrops.count()).toBe(1);
  });
});

describe('staleness helpers', () => {
  it('is stale only after 2 minutes without a successful fetch', () => {
    expect(isStale(1_000, 1_000 + 120_000)).toBe(false);
    expect(isStale(1_000, 1_000 + 120_001)).toBe(true);
    expect(isStale(0, 10_000_000)).toBe(false);
  });

  it('formats as_of as local hours and minutes', () => {
    expect(formatAsOf('2026-10-25T14:05:00Z', 'en-GB')).toMatch(/^\d{2}:\d{2}$/);
  });

  it('formats as_of in the given time zone, not the device one', () => {
    expect(formatAsOf('2026-10-25T14:05:00Z', 'en-GB', 'Asia/Kolkata')).toBe('19:35');
    expect(formatAsOf('2026-10-25T14:05:00Z', 'en-GB', 'America/New_York')).toBe('10:05');
  });
});

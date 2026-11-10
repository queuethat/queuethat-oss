import type { Session } from '@supabase/supabase-js';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../lib/query.ts';
import { sessionQuery } from './api.ts';
import { SessionLimits, useLiveScreenActivity } from './SessionLimits.tsx';

function LiveScreen() {
  useLiveScreenActivity();
  return null;
}

// Session limits: signed-in people report activity at most once a minute, and a session the
// database has ended is dropped locally and sent back to sign-in.

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  navigate: vi.fn(),
}));
vi.mock('../../lib/supabase.ts', () => ({
  supabase: {
    rpc: m.rpc,
    auth: { signOut: m.signOut, onAuthStateChange: vi.fn(), getSession: vi.fn() },
  },
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => m.navigate }));

const session = { user: { id: 'u1' } } as unknown as Session;

function mount() {
  queryClient.setQueryData(sessionQuery.queryKey, session);
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionLimits />
    </QueryClientProvider>,
  );
}

describe('SessionLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    m.rpc.mockReset().mockResolvedValue({ error: null });
    m.signOut.mockClear();
    m.navigate.mockClear();
  });
  afterEach(() => {
    cleanup();
    queryClient.clear();
    vi.useRealTimers();
  });

  it('an open live screen counts as activity without any clicks, while visible', () => {
    queryClient.setQueryData(sessionQuery.queryKey, session);
    render(
      <QueryClientProvider client={queryClient}>
        <SessionLimits />
        <LiveScreen />
      </QueryClientProvider>,
    );
    expect(m.rpc).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60_000);
    expect(m.rpc.mock.calls.length).toBeGreaterThanOrEqual(9);
    const before = m.rpc.mock.calls.length;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.advanceTimersByTime(10 * 60_000);
    expect(m.rpc).toHaveBeenCalledTimes(before);
    vi.restoreAllMocks();
  });

  it('reports activity on load, then at most once a minute', () => {
    mount();
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('touch_session');
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('keydown'));
    expect(m.rpc).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    window.dispatchEvent(new Event('pointerdown'));
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });

  it('does nothing while signed out', () => {
    queryClient.setQueryData(sessionQuery.queryKey, null);
    render(
      <QueryClientProvider client={queryClient}>
        <SessionLimits />
      </QueryClientProvider>,
    );
    window.dispatchEvent(new Event('pointerdown'));
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.navigate).not.toHaveBeenCalled();
  });

  it('drops the local session when the database says it ended', async () => {
    m.rpc.mockResolvedValue({ error: { message: 'not_found' } });
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(m.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('leaves on first use after the session disappears, not before', async () => {
    mount();
    await act(async () => {
      queryClient.setQueryData(sessionQuery.queryKey, null);
      await vi.advanceTimersByTimeAsync(1); // React Query batches notifications on a timer
    });
    expect(m.navigate).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown'));
    expect(m.navigate).toHaveBeenCalledWith({ to: '/auth/sign-in' });
  });

  it('leaves once the database says the session ended', async () => {
    m.rpc.mockResolvedValue({ error: { message: 'not_found' } });
    mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.navigate).toHaveBeenCalledWith({ to: '/auth/sign-in' });
  });
});

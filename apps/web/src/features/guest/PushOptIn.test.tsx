import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushOptIn, SLOW_HINT_MS } from './PushOptIn.tsx';

const m = vi.hoisted(() => ({
  support: 'available' as string,
  ios: false,
  subscribe: vi.fn(),
  remember: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('./push.ts', () => ({
  pushSupport: () => m.support,
  isIOS: () => m.ios,
  subscribeToPush: m.subscribe,
  rememberPushVisit: m.remember,
}));
vi.mock('./client.ts', () => ({ guestRpc: m.rpc }));

const keys = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'p', auth: 'a' };

function show() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PushOptIn token="tok-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  m.support = 'available';
  m.ios = false;
  m.subscribe.mockResolvedValue(keys);
  m.rpc.mockResolvedValue(null);
  m.remember.mockResolvedValue(undefined);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** A subscribeToPush the test drives: it reports steps and settles when told. */
function controlledSubscribe() {
  let begin = () => {};
  const c = {
    started: new Promise<void>((r) => (begin = r)),
    step: (_: string) => {},
    resolve: (_: typeof keys) => {},
    reject: (_: Error) => {},
  };
  m.subscribe.mockImplementation(
    (onStep: (step: string) => void) =>
      new Promise((resolve, reject) => {
        c.step = onStep;
        c.resolve = resolve;
        c.reject = reject;
        begin();
      }),
  );
  return c;
}

describe('PushOptIn', () => {
  it('subscribes, registers the subscription for this visit and says alerts are on', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: "Alert me when it's my turn" }));
    expect((await screen.findByRole('status')).textContent).toContain('Alerts are on');
    expect(m.rpc).toHaveBeenCalledWith('guest_register_push', {
      p_token: 'tok-1',
      p_endpoint: keys.endpoint,
      p_p256dh: 'p',
      p_auth: 'a',
    });
    expect(m.remember).toHaveBeenCalledWith('tok-1');
  });

  it('remembers that alerts are on for this visit after a reload', () => {
    localStorage.setItem('qm:push:tok-1', '1');
    show();
    expect(screen.getByRole('status').textContent).toContain('Alerts are on');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('falls back to keeping the page open when the guest says no', async () => {
    m.subscribe.mockRejectedValue(new Error('denied'));
    show();
    fireEvent.click(screen.getByRole('button'));
    expect((await screen.findByRole('alert')).textContent).toContain('Notifications are blocked');
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('tells iPhone Safari guests about the Home Screen, honestly', () => {
    m.support = 'needs_home_screen';
    show();
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows nothing where push is unavailable, except the keep-open note on iOS', () => {
    m.support = 'unavailable';
    const { container } = show();
    expect(container.innerHTML).toBe('');
    cleanup();
    m.ios = true;
    show();
    expect(screen.getByText(/Keep this page open/)).toBeTruthy();
  });

  it('says to answer the browser prompt, then that the push service can take a minute (#521)', async () => {
    vi.useFakeTimers();
    const sub = controlledSubscribe();
    show();
    fireEvent.click(screen.getByRole('button'));
    await act(() => sub.started); // the mutation starts after the tap
    act(() => sub.step('permission'));
    expect(screen.getByText('Allow notifications in the browser prompt.')).toBeTruthy();
    act(() => sub.step('subscribing'));
    expect(screen.queryByText(/browser prompt/)).toBeNull();
    act(() => vi.advanceTimersByTime(SLOW_HINT_MS - 1));
    expect(screen.queryByText(/up to a minute/)).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText(/This can take up to a minute/)).toBeTruthy();
    vi.useRealTimers();
    act(() => sub.resolve(keys));
    expect((await screen.findByText(/Alerts are on/)).textContent).toBeTruthy();
    expect(screen.queryByText(/up to a minute/)).toBeNull();
  });

  it('after a timeout, explains and lets the guest try again', async () => {
    const sub = controlledSubscribe();
    show();
    fireEvent.click(screen.getByRole('button'));
    await act(() => sub.started);
    act(() => sub.reject(new Error('timeout')));
    expect((await screen.findByRole('alert')).textContent).toContain('took too long');
    expect(screen.queryByText(/up to a minute|browser prompt/)).toBeNull();
    m.subscribe.mockResolvedValue(keys);
    fireEvent.click(screen.getByRole('button', { name: "Alert me when it's my turn" }));
    expect(await screen.findByText(/Alerts are on/)).toBeTruthy();
    expect(m.subscribe).toHaveBeenCalledTimes(2);
  });
});

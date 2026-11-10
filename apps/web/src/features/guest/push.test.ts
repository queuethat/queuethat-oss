import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetPushVisit,
  rememberPushVisit,
  SUBSCRIBE_TIMEOUT_MS,
  subscribeToPush,
} from './push.ts';
import { PUSH_VISIT_KEY } from './pushRouting.ts';

/** Just enough Cache Storage for one entry. */
function fakeCaches() {
  const store = new Map<string, string>();
  const cache = {
    put: async (key: string, res: Response) => void store.set(key, await res.text()),
    match: async (key: string) => (store.has(key) ? new Response(store.get(key)) : undefined),
    delete: async (key: string) => store.delete(key),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  return store;
}

/** A permission the guest grants (or already granted) and a push manager we control. */
function fakeWorker(
  pushManager: { getSubscription: () => unknown; subscribe: () => unknown },
  permission: NotificationPermission = 'default',
) {
  const requestPermission = vi.fn(async () => 'granted');
  vi.stubGlobal('Notification', { permission, requestPermission });
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager }) } });
  return requestPermission;
}

const subscription = {
  toJSON: () => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/x',
    keys: { p256dh: 'p', auth: 'a' },
  }),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('subscribeToPush', () => {
  it('reports the prompt, then the push service, and times out a push service that never answers', async () => {
    vi.useFakeTimers();
    const subscribe = vi.fn(() => new Promise(() => {}));
    fakeWorker({ getSubscription: async () => null, subscribe });
    const steps: string[] = [];
    const result = subscribeToPush((step) => steps.push(step));
    const failed = expect(result).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_TIMEOUT_MS - 1);
    expect(steps).toEqual(['permission', 'subscribing']);
    expect(subscribe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
  });

  it('on a retry, reuses the subscription that finished after the timeout', async () => {
    const subscribe = vi.fn();
    fakeWorker({ getSubscription: async () => subscription, subscribe });
    await expect(subscribeToPush()).resolves.toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      p256dh: 'p',
      auth: 'a',
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('skips the prompt step when notifications are already allowed', async () => {
    const requestPermission = fakeWorker(
      { getSubscription: async () => subscription, subscribe: vi.fn() },
      'granted',
    );
    const steps: string[] = [];
    await subscribeToPush((step) => steps.push(step));
    expect(steps).toEqual(['subscribing']);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('push visit hand-off to the service worker', () => {
  it('forgets the stored visit when that visit ends', async () => {
    const store = fakeCaches();
    await rememberPushVisit('tok-1');
    expect(store.get(PUSH_VISIT_KEY)).toBe('tok-1');
    await forgetPushVisit('tok-1');
    expect(store.has(PUSH_VISIT_KEY)).toBe(false);
  });

  it("keeps a newer visit's entry when an older one ends", async () => {
    const store = fakeCaches();
    await rememberPushVisit('tok-2');
    await forgetPushVisit('tok-1');
    expect(store.get(PUSH_VISIT_KEY)).toBe('tok-2');
  });
});

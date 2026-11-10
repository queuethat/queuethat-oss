import { PUSH_CACHE, PUSH_VISIT_KEY } from './pushRouting.ts';
import { appConfig } from '../../lib/config.ts';

/**
 * What this browser can do for "tell me when it's my turn":
 * `available` (it can subscribe), `needs_home_screen` (an iPhone or iPad Safari tab: Apple allows
 * web push only once the page is added to the Home Screen), `blocked` (the guest denied
 * notifications) or `unavailable` (no push support, or no VAPID key configured).
 */
export type PushSupport = 'available' | 'needs_home_screen' | 'blocked' | 'unavailable';

export function pushSupport(): PushSupport {
  if (!appConfig().vapidPublicKey) return 'unavailable';
  const capable =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (capable) return Notification.permission === 'denied' ? 'blocked' : 'available';
  return isIOS() && !isStandalone() ? 'needs_home_screen' : 'unavailable';
}

/** iPhone, or an iPad that reports itself as a Mac. */
export function isIOS() {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
  );
}

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export interface PushKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Where subscribeToPush is: waiting on the browser's permission prompt, or on its push service. */
export type PushStep = 'permission' | 'subscribing';

/** Longest wait for the push service; a fresh Chrome profile took 28.6 s to register (#521). */
export const SUBSCRIBE_TIMEOUT_MS = 60_000;

/**
 * Asks for notification permission and subscribes this browser through the service worker.
 * Must run from a tap (iOS refuses otherwise). Reports each step through `onStep`; 'permission'
 * only when the browser will actually prompt. Rejects with
 * Error('denied') when the guest says no, Error('no_worker') when no service worker takes control
 * within 10 s (dev server, blocked) and Error('timeout') when the push service doesn't answer within
 * SUBSCRIBE_TIMEOUT_MS. Retrying after a timeout reuses a subscription that finished meanwhile.
 */
export async function subscribeToPush(onStep?: (step: PushStep) => void): Promise<PushKeys> {
  // Already allowed (an earlier visit, a retry): no prompt, so no "allow the prompt" hint either.
  if (Notification.permission !== 'granted') {
    onStep?.('permission');
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('denied');
  }
  onStep?.('subscribing');
  const registration = await within(navigator.serviceWorker.ready, 10_000, 'no_worker');
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await within(
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(appConfig().vapidPublicKey),
      }),
      SUBSCRIBE_TIMEOUT_MS,
      'timeout',
    ));
  const json = subscription.toJSON();
  return {
    endpoint: json.endpoint ?? '',
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
  };
}

function within<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Lets the service worker open this visit's status page when an alert is tapped. */
export async function rememberPushVisit(token: string) {
  try {
    const cache = await caches.open(PUSH_CACHE);
    await cache.put(PUSH_VISIT_KEY, new Response(token));
  } catch {
    // Cache Storage unavailable: tapping an alert still opens or focuses a status page.
  }
}

/** Stops alert taps opening an ended visit's page (a shared phone's next guest, #504 review). */
export async function forgetPushVisit(token: string) {
  try {
    const cache = await caches.open(PUSH_CACHE);
    if ((await (await cache.match(PUSH_VISIT_KEY))?.text()) === token) {
      await cache.delete(PUSH_VISIT_KEY);
    }
  } catch {
    // Cache Storage unavailable: nothing was stored either
  }
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

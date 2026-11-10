/// <reference lib="webworker" />
// Service worker (O1 #72). Precaches the built app so every route opens offline as the shell;
// the app itself shows the offline message. API calls go to Supabase on another origin and are
// never cached here. The push and notificationclick handlers (N5 #71) are at the end.
import { cacheNames, clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import {
  clickAction,
  noticeFor,
  PUSH_CACHE,
  PUSH_VISIT_KEY,
} from './features/guest/pushRouting.ts';

declare const self: ServiceWorkerGlobalScope;

// The previous version's hashed files. A tab that still runs that version (it hasn't taken the
// update yet) can keep lazy-loading its routes after this worker replaces the precache.
const PREVIOUS_ASSETS = 'assets-previous';

// Runs before precacheAndRoute's own install handler, so the precache still holds the old version.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const precache = await caches.open(cacheNames.precache);
      const requests = (await precache.keys()).filter((r) =>
        new URL(r.url).pathname.startsWith('/assets/'),
      );
      if (requests.length === 0) return;
      await caches.delete(PREVIOUS_ASSETS);
      const previous = await caches.open(PREVIOUS_ASSETS);
      for (const request of requests) {
        const response = await precache.match(request);
        if (response) await previous.put(request, response);
      }
    })(),
  );
});

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Current files are answered by the precache route above; only old ones reach this.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/assets/'),
  async ({ request }) =>
    (await caches.match(request, { cacheName: PREVIOUS_ASSETS, ignoreVary: true })) ??
    fetch(request),
);

// /config.js is written per install when the container starts (lib/config.ts), so it is never
// precached: the network wins and the last answer covers offline starts.
const CONFIG_CACHE = 'config';
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname === '/config.js',
  async ({ request }) => {
    const cache = await caches.open(CONFIG_CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;
      throw error;
    }
  },
);

// Single-page app: every navigation gets the precached index.html, online or not.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// A new version waits until a tab asks for it (features/pwa), so staff never lose
// half-entered work to a surprise reload.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

clientsClaim();

// Web push from the dispatcher (N4). Every push shows a notification: browsers revoke push for
// workers that receive one silently.
self.addEventListener('push', (event) => {
  const notice = noticeFor(event.data?.text() ?? null);
  event.waitUntil(
    self.registration.showNotification(notice.title, {
      body: notice.body,
      tag: notice.tag,
      icon: '/pwa-192x192.png',
      data: { url: notice.url },
    }),
  );
});

// Tapping the alert opens (or focuses) the guest's status page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const pushUrl = (event.notification.data as { url?: string | null } | null)?.url ?? null;
  event.waitUntil(
    (async () => {
      const stored = await caches
        .open(PUSH_CACHE)
        .then((c) => c.match(PUSH_VISIT_KEY))
        .then((r) => r?.text() ?? null)
        .catch(() => null);
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const action = clickAction(
        pushUrl,
        stored,
        windows.map((w) => w.url),
        self.location.origin,
      );
      if ('focus' in action) await windows[action.focus]!.focus();
      else await self.clients.openWindow(action.open);
    })(),
  );
});

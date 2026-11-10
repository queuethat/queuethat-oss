import { useCallback, useEffect, useState } from 'react';

const SW_URL = `${import.meta.env.BASE_URL}sw.js`;

// Set just before this tab asks the waiting worker to take over, so the controllerchange that
// follows reloads this tab only. Tabs that did not ask keep running until their own policy says so.
let requestedHere = false;

/**
 * Registers the service worker and reports whether this tab runs out-of-date code.
 * `updateReady` is true in every open tab once a new version is waiting, and stays true in tabs
 * whose worker was swapped by another tab. `apply()` moves this tab to the new version.
 */
export function useAppUpdate(): { updateReady: boolean; apply: () => void } {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    const container = navigator.serviceWorker;
    if (!container || import.meta.env.DEV) return;
    let cancelled = false;

    // A worker that installs while another one controls the page is an update, not the first install.
    const watch = (worker: ServiceWorker | null) =>
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && container.controller) setUpdateReady(true);
      });

    // The first install claims an uncontrolled page; that is not an update.
    let hadController = Boolean(container.controller);
    const onControllerChange = () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      if (requestedHere) window.location.reload();
      else setUpdateReady(true);
    };
    container.addEventListener('controllerchange', onControllerChange);

    container.register(SW_URL, { scope: import.meta.env.BASE_URL }).then((reg) => {
      if (cancelled) return;
      setRegistration(reg);
      if (reg.waiting && container.controller) setUpdateReady(true);
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
    }, console.error);

    return () => {
      cancelled = true;
      container.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  const apply = useCallback(() => {
    const waiting = registration?.waiting;
    if (!waiting) {
      // Another tab already activated the new worker; this tab only needs fresh code.
      window.location.reload();
      return;
    }
    requestedHere = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }, [registration]);

  return { updateReady, apply };
}

/**
 * Asks the browser to fetch the service worker now instead of on its own schedule, so a deploy
 * that /version.json already reports is picked up (D3, #50). A new version then arrives through
 * `useAppUpdate` as usual. Returns false when no service worker controls this page (dev builds,
 * unsupported browsers): the caller should reload instead.
 */
export async function checkForUpdate(): Promise<boolean> {
  const container = navigator.serviceWorker;
  const registration = container?.controller ? await container.getRegistration() : undefined;
  if (!registration) return false;
  await registration.update();
  return true;
}

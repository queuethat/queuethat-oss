import type { i18n as I18n } from 'i18next';
import { extensions } from '../extensions/installed.ts';
import { createI18n } from './i18n-core.ts';
import common from '../locales/en/common.json';
import display from '../locales/en/display.json';
import eta from '../locales/en/eta.ts';
import guest from '../locales/en/guest.json';
import type { Namespace } from '../locales/en/index.ts';
import { detectLocale, savedLocale, setGuestLocale } from './locale.ts';

export const defaultNS = 'common';

/**
 * Namespaces every guest, display and kiosk page needs, bundled so they render with no fetch. The
 * join and status strings (`guest-join`, `guest-status`) are not: each loads with its route, so
 * /q and /v stay under the guest bundle budget. They answer `t('join.…')` and `t('status.…')` of
 * the `guest` namespace through `fallbackNS`.
 */
const bundled = { common, guest, display, eta };

// Every other area's strings load with that area (`loadNamespaces`), so guests on mobile data
// never download staff and admin text.
const lazy = import.meta.glob<{ default: Record<string, unknown> }>('../locales/*/*.json');

const i18next = createI18n({
  language: 'en',
  fallbackLanguage: 'en',
  defaultNS,
  // The join and status strings answer `t('join.…')` and `t('status.…')` of the `guest` namespace.
  fallbackNS: ['guest-join', 'guest-status'],
  resources: bundled,
  load: async (lng, ns) => {
    const shipped = (await lazy[`../locales/${lng}/${ns}.json`]?.())?.default;
    const changed = await extensions.localeOverrides?.(lng, ns);
    return changed ? deepMerge(shipped ?? {}, changed) : shipped;
  },
}) as unknown as I18n;

/** `over` laid onto `base`, nested objects merged; neither is changed. */
export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const was = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && was && typeof was === 'object'
        ? deepMerge(was as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

// A deployment's wording for the bundled namespaces arrives once the app has started.
if (extensions.localeOverrides) {
  for (const ns of Object.keys(bundled)) {
    void extensions.localeOverrides('en', ns).then((changed) => {
      if (changed) i18next.addResourceBundle('en', ns, changed, true, true);
    });
  }
}

/**
 * Loads an area's namespaces before its screens render. Call it from the area's layout route
 * `beforeLoad`; `t()` for a namespace that hasn't loaded returns the key.
 */
export function loadNamespaces(...namespaces: Namespace[]) {
  return i18next.loadNamespaces(namespaces);
}

/**
 * Keeps `<html lang dir>` in step with the active language, so screen readers pick the
 * right voice and an RTL locale flips the layout. Only English ships in phase 1; this is
 * the hook a right-to-left language plugs into later.
 */
export function syncDocumentLanguage(
  instance: {
    language: string;
    dir(lng?: string): string;
    on(event: 'languageChanged', fn: (lng: string) => void): void;
  },
  doc: Document = document,
) {
  const apply = (lng: string) => {
    doc.documentElement.lang = lng;
    doc.documentElement.dir = instance.dir(lng);
  };
  instance.on('languageChanged', apply);
  if (instance.language) apply(instance.language);
}

if (typeof document !== 'undefined') syncDocumentLanguage(i18next);

// Staff and admin screens are English only, so only guest URLs follow the guest's language. The
// kiosk is shared, so it never reads or keeps a previous guest's choice.
if (typeof window !== 'undefined') {
  const kiosk = /^\/kiosk(\/|$)/.test(window.location.pathname);
  if (kiosk || /^\/[qv](\/|$)/.test(window.location.pathname)) {
    const locale = detectLocale(kiosk ? null : savedLocale(), navigator.languages ?? []);
    if (locale !== 'en') void setGuestLocale(i18next, locale, false);
  }
}

export default i18next;

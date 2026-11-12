/** The languages guest pages are translated into; `en` is the fallback for every string. */
export const GUEST_LOCALES = ['en', 'es', 'de', 'fr'] as const;
export type GuestLocale = (typeof GUEST_LOCALES)[number];

/** Each language in its own words, so a guest can find theirs whatever the page says now. */
export const LOCALE_NAMES: Record<GuestLocale, string> = {
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
};

const STORAGE_KEY = 'qm.locale';

const asLocale = (tag: string | null | undefined): GuestLocale | null => {
  const base = tag?.toLowerCase().split('-')[0];
  return GUEST_LOCALES.find((l) => l === base) ?? null;
};

/**
 * The language to show: the guest's saved choice, else the first of the browser's languages we
 * have (es-MX gives es), else English.
 */
export function detectLocale(saved: string | null, languages: readonly string[]): GuestLocale {
  return asLocale(saved) ?? languages.map(asLocale).find(Boolean) ?? 'en';
}

/** The saved choice, or null; storage can be blocked or empty (private windows). */
export function savedLocale(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveLocale(locale: GuestLocale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // The choice then lasts until the page closes.
  }
}

/** What guest pages read beyond the always-loaded strings; fetched when another language is picked. */
const GUEST_NAMESPACES = [
  'guest-join',
  'guest-status',
  'guest-snooze',
  'guest-feedback',
  'guest-chat',
  'guest-party',
  'guest-intake',
  'guest-info',
  'kiosk',
  'eta',
];

/**
 * Shows guest pages in `locale` on `i18n`. A string a translation lacks shows in English.
 * `persist` remembers the choice on this device (not for the shared kiosk). Takes the instance
 * so this file stays free of i18next and the picker's chunk does not pull it out of the entry.
 */
export async function setGuestLocale(
  i18n: {
    changeLanguage: (lng: string) => Promise<unknown>;
    loadNamespaces: (ns: string[]) => Promise<void>;
  },
  locale: GuestLocale,
  persist = true,
) {
  if (persist) saveLocale(locale);
  await i18n.changeLanguage(locale);
  await i18n.loadNamespaces(GUEST_NAMESPACES);
}

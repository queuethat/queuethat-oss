import type { WebExtensions } from './types.ts';

type Strings = Record<string, unknown>;

function isObject(v: unknown): v is Strings {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge for translation overrides: objects merge key by key, anything else is replaced. */
function mergeStrings(a: Strings, b: Strings): Strings {
  const out: Strings = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = isObject(prev) && isObject(v) ? mergeStrings(prev, v) : v;
  }
  return out;
}

/**
 * One `WebExtensions` from several (a build that names more than one module in
 * `QT_WEB_EXTENSIONS`, for example a deployment's own pages plus `ee/web`). Lists are joined in
 * order; slots of the same name and flags take the later module's value; locale overrides of the
 * same language and namespace are deep-merged with the later module winning.
 */
export function mergeExtensions(list: WebExtensions[]): WebExtensions {
  const overrides = list.map((e) => e.localeOverrides).filter((f) => f !== undefined);
  const helpArticles = list.flatMap((e) => e.helpArticles ?? []);
  return {
    adminPages: list.flatMap((e) => e.adminPages),
    banners: list.flatMap((e) => e.banners),
    slots: Object.assign({}, ...list.map((e) => e.slots ?? {})),
    redirects: list.flatMap((e) => e.redirects ?? []),
    ...(helpArticles.length ? { helpArticles } : {}),
    ...(list.some((e) => e.sharedSender) ? { sharedSender: true } : {}),
    ...(overrides.length
      ? {
          localeOverrides: async (lng: string, ns: string) => {
            const found = (await Promise.all(overrides.map((f) => f(lng, ns)))).filter(
              (r): r is Strings => r !== undefined,
            );
            return found.length ? found.reduce(mergeStrings) : undefined;
          },
        }
      : {}),
  };
}

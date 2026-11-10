/*
 * The translation engine: the part of i18next this app uses, in about 2 KB instead of 13. Guests
 * pay for every byte on mobile data and the guest budget (160 KB gzip) has no room for the rest.
 * It keeps i18next's names and rules so call sites and locale files are unchanged:
 *  - keys are `ns:path.to.key` (or `{ ns }`), looked up in the language, then the fallback
 *    language, trying the requested namespaces and then the fallback ones;
 *  - `count` picks `key_one` / `key_other` / ... with Intl.PluralRules, then the plain key;
 *  - `{{name}}` interpolates and `{{count, number}}` formats; a name with no value stays as written;
 *  - a missing key returns the key (or `defaultValue`); `returnObjects` returns arrays and objects.
 * Types are i18next's (type-only imports, erased at build) so typed keys keep working.
 */
type Tree = Record<string, unknown>;
type Options = {
  ns?: string | readonly string[];
  lng?: string | null;
  count?: unknown;
  defaultValue?: string;
  returnObjects?: boolean;
  [value: string]: unknown;
};
type Loader = (lng: string, ns: string) => Promise<Tree | undefined>;
type Event = 'languageChanged' | 'added';

export interface I18nConfig {
  language: string;
  fallbackLanguage: string;
  defaultNS: string;
  /** Searched after the requested namespaces. */
  fallbackNS: readonly string[];
  /** Strings that ship in the bundle, so `t()` works on the first render. */
  resources: Record<string, Tree>;
  /** Fetches a namespace the bundle lacks; resolves undefined when there is none. */
  load: Loader;
}

const RTL = new Set(['ar', 'he', 'fa', 'ur']);

const find = (tree: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, part) => (node as Tree | undefined)?.[part], tree);

const merge = (into: Tree, from: Tree, overwrite: boolean) => {
  for (const [key, value] of Object.entries(from)) {
    const here = into[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      here &&
      typeof here === 'object'
    )
      merge(here as Tree, value as Tree, overwrite);
    else if (overwrite || here === undefined) into[key] = value;
  }
};

export function createI18n(config: I18nConfig) {
  const { fallbackLanguage, defaultNS, fallbackNS, load } = config;
  const data: Record<string, Tree> = {}; // `${lng}|${ns}` -> strings
  const pending = new Map<string, Promise<void>>();
  const wanted = new Set<string>([...Object.keys(config.resources), ...fallbackNS]);
  const listeners: Record<Event, Set<(lng: string) => void>> = {
    languageChanged: new Set(),
    added: new Set(),
  };
  const emit = (event: Event) => listeners[event].forEach((fn) => fn(language));
  let language = config.language;

  const addBundle = (lng: string, ns: string, tree: Tree, deep = true, overwrite = false) => {
    const key = `${lng}|${ns}`;
    if (deep && data[key]) merge(data[key]!, tree, overwrite);
    else data[key] = tree;
    emit('added');
  };
  for (const [ns, tree] of Object.entries(config.resources)) data[`${language}|${ns}`] = tree;

  const fetchNs = (lng: string, ns: string, force = false) => {
    const key = `${lng}|${ns}`;
    if (!force && (key in data || pending.has(key))) return pending.get(key) ?? Promise.resolve();
    const job = load(lng, ns)
      .then((tree) => addBundle(lng, ns, tree ?? {}, false, true))
      .catch(() => addBundle(lng, ns, data[key] ?? {}))
      .finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  };
  const fetchAll = (lngs: readonly string[], namespaces: Iterable<string>, force = false) =>
    Promise.all(
      [...namespaces].flatMap((ns) => [...new Set(lngs)].map((lng) => fetchNs(lng, ns, force))),
    ).then(() => undefined);

  const lookup = (
    lng: string,
    namespaces: readonly string[],
    key: string,
    count: number | null,
  ) => {
    for (const code of new Set([lng, fallbackLanguage]))
      for (const ns of new Set([...namespaces, ...fallbackNS])) {
        const tree = data[`${code}|${ns}`];
        if (!tree) continue;
        // Each language has its own plural categories, so the fallback language re-selects.
        const plural = count === null ? null : new Intl.PluralRules(code).select(count);
        const value =
          (plural ? find(tree, `${key}_${plural}`) : undefined) ??
          (plural ? undefined : find(tree, key)) ??
          (plural && (typeof find(tree, key) === 'string' || Array.isArray(find(tree, key)))
            ? find(tree, key)
            : undefined);
        if (value !== undefined) return value;
      }
    return undefined;
  };

  const fill = (text: string, lng: string, options: Options) =>
    text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (match, expr: string) => {
      const [name = '', format] = expr.split(/\s*,\s*/);
      const value = options[name];
      if (value === undefined) return match;
      return format === 'number' ? new Intl.NumberFormat(lng).format(Number(value)) : String(value);
    });

  const render = (value: unknown, lng: string, options: Options): unknown =>
    typeof value === 'string'
      ? fill(value, lng, options)
      : Array.isArray(value)
        ? value.map((item) => render(item, lng, options))
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, lng, options)]))
          : value;

  function translate(
    key: string,
    options: Options = {},
    fixed: { lng?: string | null; ns?: string | readonly string[] | null; prefix?: string } = {},
  ): unknown {
    const lng = options.lng ?? fixed.lng ?? language;
    let namespaces = [options.ns ?? fixed.ns ?? defaultNS].flat() as string[];
    let path = fixed.prefix ? `${fixed.prefix}.${key}` : key;
    const colon = path.indexOf(':');
    if (colon > 0) {
      namespaces = [path.slice(0, colon)];
      path = path.slice(colon + 1);
    }
    const count =
      options.count !== undefined && typeof options.count !== 'string'
        ? Number(options.count)
        : null;
    const value = lookup(lng, namespaces, path, count);
    if (value === undefined) return fill(options.defaultValue ?? path, lng, options);
    if (typeof value === 'object' && !options.returnObjects) return path;
    return render(value, lng, options);
  }

  const instance = {
    get language() {
      return language;
    },
    get resolvedLanguage() {
      return language;
    },
    t: (key: string, options?: Options) => translate(key, options),
    /** `t` for a fixed language and namespace(s); null follows the active language. */
    getFixedT: (lng: string | null, ns?: string | readonly string[] | null, prefix?: string) => {
      const t = (key: string, options?: Options) => translate(key, options, { lng, ns, prefix });
      return t;
    },
    /** Every namespace the app has asked for, in `lng`, before the language changes. */
    async changeLanguage(lng: string) {
      await fetchAll([lng], wanted);
      language = lng;
      emit('languageChanged');
    },
    /** Loads namespaces for the active language and the fallback. */
    loadNamespaces(namespaces: string | readonly string[]) {
      const list = [namespaces].flat() as string[];
      list.forEach((ns) => wanted.add(ns));
      return fetchAll([language, fallbackLanguage], list);
    },
    /** Fetches again, e.g. after an admin edits phrases. */
    reloadResources(lngs: string | readonly string[], ns: string) {
      return fetchAll([lngs].flat() as string[], [ns], true);
    },
    hasLoadedNamespace: (ns: string) =>
      `${language}|${ns}` in data && !pending.has(`${language}|${ns}`),
    addResourceBundle: addBundle,
    dir: (lng = language) => (RTL.has(lng.split('-')[0]!) ? 'rtl' : 'ltr'),
    on(event: Event | string, fn: (lng: string) => void) {
      listeners[event as Event]?.add(fn);
    },
    off(event: Event | string, fn: (lng: string) => void) {
      listeners[event as Event]?.delete(fn);
    },
  };
  void fetchAll([language, fallbackLanguage], fallbackNS);
  return instance;
}

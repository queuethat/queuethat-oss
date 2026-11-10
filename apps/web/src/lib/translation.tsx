import type { i18n as I18n, FlatNamespace } from 'i18next';
import {
  cloneElement,
  Fragment,
  type ReactElement,
  type ReactNode,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type {
  Trans as ReactI18nextTrans,
  useTranslation as ReactI18nextUseTranslation,
} from 'react-i18next';
import i18next from './i18n.ts';

/*
 * The two react-i18next pieces this app uses, rebuilt over the i18next instance. react-i18next plus
 * its HTML parser cost about 4.8 KB gzip on every guest route, and the guest budget (160 KB) has no
 * room for it. The types stay react-i18next's (type-only import, erased at build), so typed keys
 * keep working at every call site.
 */

/** Bumps when the language changes or strings arrive, so a mounted component re-reads `t`. */
function subscribe(i18n: I18n, notify: () => void) {
  i18n.on('languageChanged', notify);
  i18n.on('added', notify);
  return () => {
    i18n.off('languageChanged', notify);
    i18n.off('added', notify);
  };
}

const versions = new WeakMap<I18n, number>();
const bump = (i18n: I18n) => versions.set(i18n, (versions.get(i18n) ?? 0) + 1);
i18next.on('languageChanged', () => bump(i18next));
i18next.on('added', () => bump(i18next));

/**
 * `t` bound to the active language and the given namespace(s), re-rendering on a language switch
 * or when a namespace's strings arrive. Like react-i18next, it suspends while a requested
 * namespace is still loading.
 */
export const useTranslation = ((
  ns?: string | readonly string[],
  options?: { keyPrefix?: string },
) => {
  const i18n = i18next;
  const version = useSyncExternalStore(
    useCallback((notify) => subscribe(i18n, notify), [i18n]),
    () => versions.get(i18n) ?? 0,
  );
  const names = (
    ns === undefined ? [] : typeof ns === 'string' ? [ns] : [...ns]
  ) as FlatNamespace[];
  const missing = names.filter((n) => !i18n.hasLoadedNamespace(n));
  if (missing.length > 0) throw i18n.loadNamespaces(missing);
  // Stable until the language or strings change, as react-i18next's is: screens list `t` in
  // effect and memo dependencies, and a new function every render re-runs them every render.
  const key = `${names.join(',')}|${options?.keyPrefix ?? ''}|${version}`;
  return useMemo(() => {
    const t = i18n.getFixedT(
      i18n.language,
      (names.length > 0 ? names : null) as never,
      options?.keyPrefix as never,
    );
    return Object.assign([t, i18n, true], { t, i18n, ready: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for names and keyPrefix
  }, [key, i18n]);
}) as unknown as typeof ReactI18nextUseTranslation;

/** Renders `<tag>…</tag>` markers in a translated string as the matching entries of `components`. */
function interleave(text: string, components: Record<string, ReactElement>): ReactNode[] {
  const out: ReactNode[] = [];
  const tag = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const element = components[m[1]!];
    out.push(
      element ? cloneElement(element, { key: out.length }, ...interleave(m[2]!, components)) : m[2],
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A translated string with elements spliced in: `<Trans t={t} i18nKey="…" components={{ a: <Link/> }} />`. */
export const Trans = (({
  t,
  i18nKey,
  values,
  components,
}: {
  t: (key: string, options?: object) => string;
  i18nKey: string;
  values?: object;
  components?: Record<string, ReactElement>;
}) => (
  <Fragment>{interleave(t(i18nKey, values), components ?? {})}</Fragment>
)) as unknown as typeof ReactI18nextTrans;

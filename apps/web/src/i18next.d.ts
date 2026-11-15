import type { defaultNS } from './lib/i18n.ts';
import type { ExtensionLocaleResources } from './extensions/types.ts';
import type { en } from './locales/en/index.ts';

// Typed keys: `t('guest:join.title')` is checked against locales/en at typecheck time.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    // A deployment's own namespaces join by declaration merging (extensions/types.ts).
    resources: typeof en & ExtensionLocaleResources;
  }
}

import type { defaultNS } from './lib/i18n.ts';
import type { en } from './locales/en/index.ts';

// Typed keys: `t('guest:join.title')` is checked against locales/en at typecheck time.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: typeof en;
  }
}

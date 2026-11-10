import { describe, expect, it } from 'vitest';
import { createI18n } from './i18n-core.ts';
import i18n, { loadNamespaces, syncDocumentLanguage } from './i18n.ts';

describe('i18n', () => {
  it('t() resolves a key from a namespace', () => {
    expect(i18n.t('join.title', { ns: 'guest' })).toBe('Join the queue');
    expect(i18n.t('guest:status.title')).toBe('Your place in line');
  });

  it('loads a staff-side namespace on demand', async () => {
    expect(i18n.hasLoadedNamespace('auth')).toBe(false);
    await loadNamespaces('auth');
    expect(i18n.t('auth:signIn.title')).toBe('Sign in');
  });

  it('defaults to the common namespace and interpolates', () => {
    expect(i18n.t('placeholder.builtIn', { ticket: 'G2 (#52)' })).toBe('Built in G2 (#52).');
  });

  it('sets <html lang dir> from the active language', async () => {
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');

    const rtl = createI18n({
      language: 'en',
      fallbackLanguage: 'en',
      defaultNS: 'common',
      fallbackNS: [],
      resources: {},
      load: async () => undefined,
    });
    const doc = document.implementation.createHTMLDocument();
    syncDocumentLanguage(rtl, doc);
    await rtl.changeLanguage('ar');
    expect(doc.documentElement.lang).toBe('ar');
    expect(doc.documentElement.dir).toBe('rtl');
  });
});

describe('i18n-core rules shared with i18next', () => {
  const make = () => {
    const i = createI18n({
      language: 'en',
      fallbackLanguage: 'en',
      defaultNS: 'common',
      fallbackNS: ['extra'],
      resources: {
        common: {
          hi: 'Hi {{name}}, {{ missing }}',
          n: { a: 'A', list: ['x {{name}}', 'y'] },
          items_one: '{{count}} item',
          items_other: '{{count, number}} items',
        },
        extra: { fromFallback: 'F' },
      },
      load: async (lng, ns) => (lng === 'es' && ns === 'common' ? { hi: 'Hola' } : undefined),
    });
    return i;
  };

  it('interpolates, leaves unknown names, and returns the key when missing', () => {
    const i = make();
    expect(i.t('hi', { name: 'Sam' })).toBe('Hi Sam, {{ missing }}');
    expect(i.t('nope')).toBe('nope');
    expect(i.t('nope', { defaultValue: 'Fallback {{name}}', name: 'Z' })).toBe('Fallback Z');
    expect(i.t('common:n.a')).toBe('A');
    expect(i.t('fromFallback')).toBe('F');
  });

  it('picks plural forms and formats numbers', () => {
    const i = make();
    expect(i.t('items', { count: 1 })).toBe('1 item');
    expect(i.t('items', { count: 1234 })).toBe('1,234 items');
  });

  it('returns arrays when asked, with values filled', () => {
    const i = make();
    expect(i.t('n.list', { returnObjects: true, name: 'Q' })).toEqual(['x Q', 'y']);
  });

  it('switches language after loading it, and falls back to English per key', async () => {
    const i = make();
    await i.changeLanguage('es');
    expect(i.language).toBe('es');
    expect(i.t('hi')).toBe('Hola');
    expect(i.t('n.a')).toBe('A');
    expect(i.getFixedT('en')('hi', { name: 'B' })).toBe('Hi B, {{ missing }}');
  });
});

import { describe, expect, it } from 'vitest';
import { detectLocale, GUEST_LOCALES, LOCALE_NAMES } from './locale.ts';

describe('detectLocale', () => {
  it('offers English, Spanish, German and French, each named in its own language', () => {
    expect([...GUEST_LOCALES]).toEqual(['en', 'es', 'de', 'fr']);
    expect(LOCALE_NAMES).toEqual({ en: 'English', es: 'Español', de: 'Deutsch', fr: 'Français' });
  });

  it('prefers the saved choice, then the first browser language we have, then English', () => {
    expect(detectLocale('de', ['fr'])).toBe('de');
    expect(detectLocale(null, ['it-IT', 'fr-CA', 'es'])).toBe('fr');
    expect(detectLocale(null, ['de-AT'])).toBe('de');
    expect(detectLocale('xx', ['pt-BR'])).toBe('en');
  });
});

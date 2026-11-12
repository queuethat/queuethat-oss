import { describe, expect, it } from 'vitest';
import { fieldProblems, isEvidence, MAX_BODY, MAX_FIELDS } from '../builder/fields.ts';
import { STARTERS, starterForm } from './starters.ts';

// Words a starter must never use: no waiver here is marketed as binding, and no copy claims a
// regulatory standard (marketing rule, Riz 2026-11-09).
const FORBIDDEN = /legally binding|binding|hipaa|phi\b|certified|compliant/i;

describe('starter waivers (W6)', () => {
  it('ships tattoo, activity centre and spa, each with the not-legal-advice banner', () => {
    expect(STARTERS.map((s) => s.key)).toEqual(['tattoo', 'activity_centre', 'spa']);
    for (const s of STARTERS) {
      expect(s.waiver_banner.en).toBe(
        'A starting point, not legal advice. Have your own counsel review before using.',
      );
      expect(s.waiver_banner.es.trim()).not.toBe('');
    }
  });

  for (const lang of ['en', 'es'] as const) {
    describe(lang, () => {
      for (const { key } of STARTERS) {
        it(`${key} opens as a form the builder accepts`, () => {
          const form = starterForm(key, lang)!;
          expect(form.name.trim()).not.toBe('');
          expect(form.name.length).toBeLessThanOrEqual(80);
          expect(form.purposeText.length).toBeLessThanOrEqual(300);
          expect(form.fields.length).toBeLessThanOrEqual(MAX_FIELDS);
          expect(new Set(form.fields.map((f) => f.key)).size).toBe(form.fields.length);
          for (const field of form.fields) {
            expect(fieldProblems(field)).toEqual([]);
            expect(field.body?.length ?? 0).toBeLessThanOrEqual(MAX_BODY);
          }
          const text = JSON.stringify(form);
          expect(text).not.toMatch(FORBIDDEN);
          // A signature needs an agreement before it (W1), and every starter asks for one.
          const types = form.fields.map((f) => f.type);
          expect(types).toContain('signature');
          expect(types.indexOf('agreement')).toBeLessThan(types.indexOf('signature'));
          expect(form.fields.filter((f) => isEvidence(f.type)).every((f) => f.required)).toBe(true);
        });
      }
    });
  }

  it('picks Spanish for an es admin and English otherwise', () => {
    expect(starterForm('spa', 'es-MX')!.name).toBe('Consentimiento para tratamientos de spa');
    expect(starterForm('spa', 'fr')!.name).toBe('Spa treatment consent');
    expect(starterForm('nope', 'en')).toBeNull();
  });

  it('asks for a guardian on the activity centre waiver only', () => {
    const guardians = STARTERS.map(
      (s) => starterForm(s.key, 'en')!.fields.some((f) => f.collect_guardian) && s.key,
    ).filter(Boolean);
    expect(guardians).toEqual(['activity_centre']);
  });
});

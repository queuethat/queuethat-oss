import { describe, expect, it } from 'vitest';
import { draftFrom, formAnswers, parseJoinForm, type FormField } from './formFields.ts';

const field = (over: Partial<FormField> & Pick<FormField, 'key' | 'type'>): FormField => ({
  label: over.key,
  help: null,
  options: [],
  required: false,
  ...over,
});

describe('parseJoinForm', () => {
  it('keeps the published order and drops what it cannot draw', () => {
    const fields = parseJoinForm({
      form_version_id: 'v1',
      fields: [
        { key: 'b', label: 'B', type: 'long_text', required: true },
        { key: 'a', label: 'A', type: 'single_choice', options: ['x', 'y'], help: 'Pick' },
        { key: 'c', label: 'C', type: 'hologram' },
        { label: 'no key', type: 'short_text' },
        null,
      ],
    });
    expect(fields.map((f) => f.key)).toEqual(['b', 'a']);
    expect(fields[0]!.required).toBe(true);
    expect(fields[1]).toMatchObject({ options: ['x', 'y'], help: 'Pick', required: false });
  });

  it('reads no form as no fields', () => {
    expect(parseJoinForm({ form_version_id: null, fields: [] })).toEqual([]);
    expect(parseJoinForm(null)).toEqual([]);
    expect(parseJoinForm({ fields: 'x' })).toEqual([]);
  });
});

describe('formAnswers', () => {
  const fields = [
    field({ key: 'note', type: 'long_text' }),
    field({ key: 'size', type: 'number' }),
    field({ key: 'areas', type: 'multi_choice', options: ['a', 'b'] }),
    field({ key: 'ok', type: 'yes_no' }),
    field({ key: 'news', type: 'marketing_consent' }),
    field({ key: 'h', type: 'heading' }),
    field({ key: 'blank', type: 'short_text', required: true }),
  ];

  it('sends only what was filled in, typed for the database, and never judges the rest', () => {
    expect(
      formAnswers(fields, {
        note: '  hello ',
        size: '3.5',
        areas: ['b'],
        ok: false,
        blank: '   ',
        h: 'ignored',
        gone: 'not in this form',
      }),
    ).toEqual({ note: 'hello', size: 3.5, areas: ['b'], ok: false });
  });

  it('leaves an untouched box and an empty list out', () => {
    expect(formAnswers(fields, { areas: [] })).toEqual({});
  });

  it('ignores a draft value of the wrong shape after the form changed under it', () => {
    expect(formAnswers(fields, { ok: 'true', areas: 'a', note: true })).toEqual({});
  });
});

describe('draftFrom', () => {
  it('turns answers back into what the form holds', () => {
    const fields = [field({ key: 'n', type: 'number' }), field({ key: 'a', type: 'multi_choice' })];
    expect(draftFrom(fields, { n: 4, a: ['x'], other: 'y' })).toEqual({ n: '4', a: ['x'] });
  });
});

describe('agreement and signature', () => {
  const agreement = field({ key: 'a', type: 'agreement', body: 'Text', required: true });
  const signature = field({ key: 's', type: 'signature', collectGuardian: true, required: true });

  it('keeps agreement and signature fields with their body and guardian flag', () => {
    const fields = parseJoinForm({
      fields: [
        { key: 'a', label: 'Waiver', type: 'agreement', body: 'Read **this**', required: true },
        { key: 's', label: 'Sign', type: 'signature', collect_guardian: true },
        { key: 't', label: 'Sign 2', type: 'signature' },
      ],
    });
    expect(fields.map((f) => f.key)).toEqual(['a', 's', 't']);
    expect(fields[0]).toMatchObject({ body: 'Read **this**', required: true });
    expect(fields[1]!.collectGuardian).toBe(true);
    expect(fields[2]!.collectGuardian).toBeUndefined();
  });

  it('sends acceptance only when ticked, and never evidence', () => {
    expect(formAnswers([agreement], { a: true })).toEqual({ a: true });
    expect(formAnswers([agreement], { a: false })).toEqual({});
    expect(formAnswers([agreement], {})).toEqual({});
  });

  it('sends the typed names and leaves blanks out', () => {
    expect(formAnswers([signature], { s: ' Ana Ruiz ', 's.guardian': ' Luis ' })).toEqual({
      s: { name: 'Ana Ruiz', guardian_name: 'Luis' },
    });
    expect(formAnswers([signature], { s: 'Ana Ruiz', 's.guardian': '  ' })).toEqual({
      s: { name: 'Ana Ruiz' },
    });
    expect(formAnswers([signature], { 's.guardian': 'Luis' })).toEqual({});
  });

  it('ignores a guardian name when the business did not ask for one', () => {
    const plain = field({ key: 's', type: 'signature' });
    expect(formAnswers([plain], { s: 'Ana', 's.guardian': 'Luis' })).toEqual({
      s: { name: 'Ana' },
    });
  });

  it('rebuilds a draft from refused answers', () => {
    expect(draftFrom([signature], { s: { name: 'Ana', guardian_name: 'Luis' } })).toEqual({
      s: 'Ana',
      's.guardian': 'Luis',
    });
  });
});

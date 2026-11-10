import { describe, expect, it } from 'vitest';
import {
  MAX_FIELDS,
  fieldProblems,
  fieldWarnings,
  insertField,
  newField,
  nextKey,
  parseOptions,
  patchField,
  type BuilderField,
} from './fields.ts';

const text = (key: string): BuilderField => ({ key, label: key, type: 'short_text' });

describe('keys', () => {
  it('takes the first unused number for the type', () => {
    expect(nextKey('short_text', [])).toBe('short_text_1');
    expect(nextKey('short_text', ['short_text_1', 'short_text_3'])).toBe('short_text_2');
  });

  it('keys match the database pattern', () => {
    expect(nextKey('marketing_consent', [])).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });
});

describe('newField and insertField', () => {
  it('gives only choice types options', () => {
    expect(newField('single_choice', [], 'Pick', ['A', 'B']).options).toEqual(['A', 'B']);
    expect(newField('number', [], 'How many', ['A'])).not.toHaveProperty('options');
  });

  it('inserts at an index, clamped', () => {
    const base = [text('a'), text('b')];
    expect(insertField(base, text('c'), 1).map((f) => f.key)).toEqual(['a', 'c', 'b']);
    expect(insertField(base, text('c'), 99).map((f) => f.key)).toEqual(['a', 'b', 'c']);
    expect(insertField(base, text('c'), -4).map((f) => f.key)).toEqual(['c', 'a', 'b']);
  });

  it('refuses a 21st field and a repeated key', () => {
    const full = Array.from({ length: MAX_FIELDS }, (_, i) => text(`f${i}`));
    expect(insertField(full, text('extra'), 0)).toHaveLength(MAX_FIELDS);
    expect(insertField([text('a')], text('a'), 0)).toHaveLength(1);
  });
});

describe('patchField', () => {
  it('drops defaults so the stored shape stays minimal', () => {
    const f = patchField(text('a'), {
      help: ' ',
      required: false,
      visibility: 'guest',
      sensitivity: 'normal',
    });
    expect(f).toEqual({ key: 'a', label: 'a', type: 'short_text' });
  });

  it('keeps non-default values', () => {
    const f = patchField(text('a'), { required: true, visibility: 'staff_only', help: 'Hi' });
    expect(f).toMatchObject({ required: true, visibility: 'staff_only', help: 'Hi' });
  });
});

describe('options, problems, warnings', () => {
  it('parses one option per line', () => {
    expect(parseOptions(' A \n\nB\n')).toEqual(['A', 'B']);
  });

  it('flags empty labels, missing and repeated choices', () => {
    expect(fieldProblems({ ...text('a'), label: ' ' })).toEqual(['label']);
    expect(fieldProblems({ key: 'a', label: 'x', type: 'single_choice', options: [] })).toEqual([
      'options',
    ]);
    expect(
      fieldProblems({ key: 'a', label: 'x', type: 'multi_choice', options: ['A', 'A'] }),
    ).toEqual(['duplicate']);
    expect(fieldProblems(text('a'))).toEqual([]);
  });

  it('warns only for sensitive fields, more in a health-tagged org', () => {
    expect(fieldWarnings({ ...text('a'), sensitivity: 'personal' }, true)).toEqual([]);
    expect(fieldWarnings({ ...text('a'), sensitivity: 'sensitive' }, false)).toEqual(['sensitive']);
    expect(fieldWarnings({ ...text('a'), sensitivity: 'sensitive' }, true)).toEqual([
      'sensitive',
      'sensitive_health',
    ]);
  });
});

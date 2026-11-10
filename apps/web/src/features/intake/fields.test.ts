import { describe, expect, it } from 'vitest';
import { answersPayload, firstMissing, parseFields } from './fields.ts';

const fields = parseFields([
  { key: 'reason', label: 'Reason', help: null, type: 'text', options: null, required: true },
  { key: 'size', label: 'Size', help: null, type: 'select', options: ['S', 'M'], required: false },
  { key: 'age', label: 'Age', help: null, type: 'number', options: null, required: false },
  { key: 'agree', label: 'Agree', help: null, type: 'checkbox', options: null, required: true },
  { key: 'bad', label: 'Bad', type: 'hologram' },
  'junk',
]);

describe('intake fields', () => {
  it('keeps well-formed fields and drops malformed ones', () => {
    expect(fields.map((f) => f.key)).toEqual(['reason', 'size', 'age', 'agree']);
  });

  it('finds the first required field left blank (AC1: focus goes there, nothing is sent)', () => {
    expect(firstMissing(fields, { reason: '  ', agree: 'true' })?.key).toBe('reason');
    expect(firstMissing(fields, { reason: 'Cut', agree: 'false' })?.key).toBe('agree');
    expect(firstMissing(fields, { reason: 'Cut', agree: 'true' })).toBeNull();
  });

  it('sends only answered fields, numbers as numbers and trimmed text', () => {
    expect(answersPayload(fields, { reason: ' Cut ', size: '', age: '34', agree: 'true' })).toEqual(
      {
        reason: 'Cut',
        age: 34,
        agree: true,
      },
    );
  });
});

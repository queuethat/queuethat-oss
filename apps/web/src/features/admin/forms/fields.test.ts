import { describe, expect, it } from 'vitest';
import { fieldsPayload, fromStored } from './fields.ts';

describe('form fields', () => {
  it('opens legacy types as their canonical types and drops what it cannot draw', () => {
    const out = fromStored([
      { key: 'a', label: 'A', type: 'text', position: 3 },
      { key: 'b', label: 'B', type: 'select', options: ['x'], required: true },
      { key: 'c', label: 'C', type: 'checkbox', visibility: 'staff_only' },
      { key: 'd', label: 'D', type: 'file' },
      { label: 'no key', type: 'text' },
    ]);
    expect(out).toEqual([
      { key: 'a', label: 'A', type: 'short_text' },
      { key: 'b', label: 'B', type: 'single_choice', options: ['x'], required: true },
      { key: 'c', label: 'C', type: 'yes_no', visibility: 'staff_only' },
    ]);
    expect(fromStored(null)).toEqual([]);
  });
  it('keeps a yes/no gate (must_be_true) through an edit, and only on yes/no', () => {
    const out = fromStored([
      {
        key: 'age',
        label: 'Are you 18 or older?',
        type: 'yes_no',
        required: true,
        must_be_true: true,
      },
      { key: 'n', label: 'Name', type: 'short_text', must_be_true: true },
    ]);
    expect(out).toEqual([
      {
        key: 'age',
        label: 'Are you 18 or older?',
        type: 'yes_no',
        required: true,
        must_be_true: true,
      },
      { key: 'n', label: 'Name', type: 'short_text' },
    ]);
  });
  it('sends list order and trimmed labels', () => {
    const out = fieldsPayload([{ key: 'a', label: ' A ', type: 'short_text' }]);
    expect(out).toEqual([{ key: 'a', label: 'A', type: 'short_text' }]);
  });
});

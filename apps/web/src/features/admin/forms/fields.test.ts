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
  it('sends list order and trimmed labels', () => {
    const out = fieldsPayload([{ key: 'a', label: ' A ', type: 'short_text' }]);
    expect(out).toEqual([{ key: 'a', label: 'A', type: 'short_text' }]);
  });
});

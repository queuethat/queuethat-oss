import { describe, expect, it } from 'vitest';
import type { BuilderField } from '../fields.ts';
import { fillSeconds } from './estimate.ts';

const f = (type: BuilderField['type'], extra: Partial<BuilderField> = {}): BuilderField => ({
  key: type,
  label: type,
  type,
  ...extra,
});

describe('fillSeconds', () => {
  it('is 0 for an empty form or one with only staff fields', () => {
    expect(fillSeconds([])).toBe(0);
    expect(fillSeconds([f('short_text', { visibility: 'staff_only' })])).toBe(0);
  });
  it('sums the guest fields and rounds up to 5', () => {
    expect(fillSeconds([f('short_text'), f('yes_no')])).toBe(15);
    expect(fillSeconds([f('long_text'), f('short_text'), f('short_text')])).toBe(40);
    expect(fillSeconds([f('heading')])).toBe(5);
  });
});

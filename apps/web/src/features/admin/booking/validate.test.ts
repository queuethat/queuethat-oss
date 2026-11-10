import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './api.ts';
import { validatePolicy } from './validate.ts';

describe('validatePolicy', () => {
  it('accepts the database defaults', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual({});
  });

  it('allows any slot length from 5 minutes', () => {
    expect(validatePolicy({ ...DEFAULT_POLICY, slotMinutes: 5 })).toEqual({});
    expect(validatePolicy({ ...DEFAULT_POLICY, slotMinutes: 4 })).toHaveProperty('slotMinutes');
  });

  it('keeps the offset inside the slot', () => {
    expect(validatePolicy({ ...DEFAULT_POLICY, slotMinutes: 15, slotOffsetMinutes: 5 })).toEqual(
      {},
    );
    expect(
      validatePolicy({ ...DEFAULT_POLICY, slotMinutes: 15, slotOffsetMinutes: 15 }),
    ).toHaveProperty('slotOffsetMinutes');
  });

  it('bounds duration and horizon like the table', () => {
    const errors = validatePolicy({
      ...DEFAULT_POLICY,
      durationMinutes: 601,
      maxDaysAhead: 366,
      minNoticeMinutes: -1,
    });
    expect(Object.keys(errors).sort()).toEqual([
      'durationMinutes',
      'maxDaysAhead',
      'minNoticeMinutes',
    ]);
  });
});

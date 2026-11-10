import { describe, expect, it } from 'vitest';
import { errorCode, isRetryable } from './errors.ts';

describe('errorCode', () => {
  it('maps a database exception message to its code', () => {
    expect(errorCode({ code: 'P0001', message: 'queue_not_accepting' })).toBe(
      'queue_not_accepting',
    );
  });

  it('keeps org_suspended even when it arrives as SQLSTATE 42501', () => {
    expect(errorCode({ code: '42501', message: 'org_suspended' })).toBe('org_suspended');
  });

  it('maps SQLSTATE 42501 to permission_denied', () => {
    expect(errorCode({ code: '42501', message: 'permission denied for function call_next' })).toBe(
      'permission_denied',
    );
  });

  it('returns unknown for anything else', () => {
    expect(errorCode(new Error('network down'))).toBe('unknown');
    expect(errorCode(null)).toBe('unknown');
  });

  it('marks stale_visit as retryable', () => {
    expect(isRetryable('stale_visit')).toBe(true);
    expect(isRetryable('illegal_transition')).toBe(false);
  });
});

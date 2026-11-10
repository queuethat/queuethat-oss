import { describe, expect, it } from 'vitest';
import { reasonOf } from './reasons.ts';

describe('reasonOf', () => {
  it('prefers the suppression-list reason over the error code', () => {
    expect(reasonOf({ error_code: 'suppressed', suppression_reason: 'stop' })).toEqual({
      key: 'suppression.stop',
      values: {},
    });
  });

  it('names every suppression reason the database can store', () => {
    for (const r of ['stop', 'bounce', 'complaint', 'manual', 'platform_stop']) {
      expect(reasonOf({ error_code: null, suppression_reason: r })?.key).toBe(`suppression.${r}`);
    }
  });

  it('turns http_503 into a status, and known codes into their own key', () => {
    expect(reasonOf({ error_code: 'http_503', suppression_reason: null })).toEqual({
      key: 'http',
      values: { status: '503' },
    });
    expect(reasonOf({ error_code: 'quiet_hours', suppression_reason: null })?.key).toBe(
      'quiet_hours',
    );
  });

  it('keeps an unknown code visible so an agent can search for it', () => {
    expect(reasonOf({ error_code: 'twilio_30003', suppression_reason: null })).toEqual({
      key: 'other',
      values: { code: 'twilio_30003' },
    });
    // An unrecognised suppression reason falls through to the error code rather than inventing wording.
    expect(reasonOf({ error_code: 'blocked', suppression_reason: 'new_reason' })?.key).toBe(
      'blocked',
    );
  });

  it('has nothing to say for a clean row', () => {
    expect(reasonOf({ error_code: null, suppression_reason: null })).toBeNull();
  });
});

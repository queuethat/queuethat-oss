import { describe, expect, it } from 'vitest';
import { addGuestErrorKey } from './AddGuest.tsx';

describe('addGuestErrorKey', () => {
  it('names why a queue is not taking guests', () => {
    expect(addGuestErrorKey({ message: 'queue_not_accepting', details: 'closed' })).toBe(
      'notAccepting.closed',
    );
    expect(addGuestErrorKey({ message: 'queue_not_accepting', details: 'paused' })).toBe(
      'notAccepting.paused',
    );
    expect(addGuestErrorKey({ message: 'queue_not_accepting', details: 'something new' })).toBe(
      'notAccepting.other',
    );
  });

  it('keeps the other documented errors and folds the rest into unknown', () => {
    expect(addGuestErrorKey({ message: 'capacity_reached' })).toBe('capacity_reached');
    expect(addGuestErrorKey({ message: 'invalid_input' })).toBe('invalid_input');
    expect(addGuestErrorKey(new Error('network'))).toBe('unknown');
  });
});

import { describe, expect, it } from 'vitest';
import { formatTicket } from './index.ts';

describe('formatTicket', () => {
  it('pads to three digits', () => {
    expect(formatTicket('A', 7)).toBe('A007');
  });

  it('never truncates large numbers', () => {
    expect(formatTicket('B', 1234)).toBe('B1234');
  });
});

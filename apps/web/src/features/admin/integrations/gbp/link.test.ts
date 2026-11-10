import { describe, expect, it } from 'vitest';
import { gbpLink } from './link.ts';

describe('gbpLink', () => {
  it('is the join page with src=gbp', () =>
    expect(gbpLink('demo-barber', 'https://queue.example.com')).toBe(
      'https://queue.example.com/q/demo-barber?src=gbp',
    ));
});

import { describe, expect, it } from 'vitest';
import { waLink } from './wa-link.ts';

describe('waLink', () => {
  it('strips the plus and encodes the message', () => {
    expect(waLink('+447700900123', 'Hi Ann, ticket A012 & you')).toBe(
      'https://wa.me/447700900123?text=Hi%20Ann%2C%20ticket%20A012%20%26%20you',
    );
  });
  it('refuses anything that is not E.164', () => {
    expect(waLink('07700 900123', 'x')).toBeNull();
    expect(waLink('+0123456789', 'x')).toBeNull();
    expect(waLink('', 'x')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { joinSource } from './source.ts';

describe('joinSource', () => {
  it('reads src from the query', () => expect(joinSource('?src=gbp')).toBe('gbp'));
  it('lower-cases it', () => expect(joinSource('?src=GBP')).toBe('gbp'));
  it('is null without one', () => expect(joinSource('')).toBeNull());
  it.each(['<script>', 'a b', 'gbp;x', 'x'.repeat(13), '1', ''])('drops %j', (value) =>
    expect(joinSource(`?src=${encodeURIComponent(value)}`)).toBeNull(),
  );
  it('is always widget inside the embed', () =>
    expect(joinSource('?src=gbp', true)).toBe('widget'));
});

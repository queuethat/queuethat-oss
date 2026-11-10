import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT, safeNext } from './next.ts';

const origin = 'http://localhost:5173';

describe('safeNext', () => {
  it.each(['/staff', '/admin/queues?tab=2', '/staff#top'])('keeps the local path %s', (path) => {
    expect(safeNext(path, origin)).toBe(path);
  });

  it.each([
    undefined,
    42,
    '',
    'staff',
    'https://evil.test/',
    '//evil.test',
    '/\\evil.test',
    '/\t/evil.test',
    'javascript:alert(1)',
    '/auth/sign-in',
    '/%2e%2e/auth/callback',
    '/\n/evil.test',
    '/.//evil.test',
  ])('falls back for %s', (next) => {
    expect(safeNext(next, origin)).toBe(DEFAULT_NEXT);
  });

  it('lets a signed-out invitee come back to accept an invitation', () => {
    expect(safeNext('/auth/accept-invite?token=abc', origin)).toBe('/auth/accept-invite?token=abc');
    expect(safeNext('/auth/accept-invite/../callback', origin)).toBe(DEFAULT_NEXT);
    expect(safeNext('/auth/reset-password', origin)).toBe('/auth/reset-password');
    expect(safeNext('/auth/reset-password/../sign-in', origin)).toBe(DEFAULT_NEXT);
  });
});

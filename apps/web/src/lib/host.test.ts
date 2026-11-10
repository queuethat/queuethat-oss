import { describe, expect, it } from 'vitest';
import { decideHost, isCustomHost, isGuestPath } from './host.ts';

const MAIN = 'https://app.queuethat.com';
const deps = (host: string, slug: string | null = 'barber') => ({
  host,
  publicUrl: MAIN,
  lookup: async () => slug,
});

describe('isCustomHost', () => {
  it('is false for the main host, localhost, IPs and installs without PUBLIC_URL', () => {
    expect(isCustomHost('app.queuethat.com', MAIN)).toBe(false);
    expect(isCustomHost('APP.queuethat.com:443', MAIN)).toBe(false);
    expect(isCustomHost('localhost:5173', MAIN)).toBe(false);
    expect(isCustomHost('192.168.1.5:5173', MAIN)).toBe(false);
    expect(isCustomHost('book.barber.com', '')).toBe(false);
  });
  it('is true for any other name', () => {
    expect(isCustomHost('book.barber.com', MAIN)).toBe(true);
  });
});

describe('isGuestPath', () => {
  it('allows guest surfaces only', () => {
    for (const p of ['/q/demo', '/v/abc', '/u', '/b/x', '/o/t', '/a/t', '/w/x'])
      expect(isGuestPath(p)).toBe(true);
    for (const p of [
      '/staff',
      '/admin/domains',
      '/auth/sign-in',
      '/display',
      '/kiosk',
      '/quiet',
      '/platform',
    ]) {
      expect(isGuestPath(p)).toBe(false);
    }
  });
});

describe('decideHost', () => {
  it('AC1: / on a verified custom host shows its location', async () => {
    expect(await decideHost('/', '', deps('book.barber.com'))).toEqual({
      kind: 'location',
      slug: 'barber',
    });
  });
  it('AC2: /staff on a custom host goes to the same path on the main host', async () => {
    expect(await decideHost('/staff/queue', '?x=1', deps('book.barber.com'))).toEqual({
      kind: 'redirect',
      href: 'https://app.queuethat.com/staff/queue?x=1',
    });
  });
  it('guest paths stay on the custom host without a lookup', async () => {
    const d = {
      ...deps('book.barber.com'),
      lookup: async () => Promise.reject(new Error('no lookup')),
    };
    expect(await decideHost('/q/barber', '', d)).toEqual({ kind: 'main' });
  });
  it('an unverified custom host keeps the normal home page', async () => {
    expect(await decideHost('/', '', deps('book.barber.com', null))).toEqual({ kind: 'main' });
  });
  it('the main host is never looked up or redirected', async () => {
    const d = {
      ...deps('app.queuethat.com'),
      lookup: async () => Promise.reject(new Error('no lookup')),
    };
    expect(await decideHost('/', '', d)).toEqual({ kind: 'main' });
    expect(await decideHost('/admin', '', d)).toEqual({ kind: 'main' });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/supabase.ts', () => ({ supabase: {} }));
vi.mock('../auth/current.ts', () => ({ selectLocation: vi.fn() }));
vi.mock('./templates.tsx', () => ({ applyTemplate: vi.fn() }));
import { browserTimeZone, timeZones } from './api.ts';

describe('time zone helpers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists UTC even when Intl omits it', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Europe/Paris']);
    expect(timeZones()).toContain('UTC');
  });

  it('maps Etc/UTC to a listed zone', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
      resolvedOptions: () => ({ timeZone: 'Etc/UTC' }),
    } as Intl.DateTimeFormat);
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Europe/Paris']);
    expect(timeZones()).toContain(browserTimeZone());
  });
});

import { describe, expect, it } from 'vitest';
import { allNamed, defaultProviders, MAX_PROVIDERS, resize } from './ProviderFields.tsx';

describe('provider setup', () => {
  it('starts with one unnamed line, whatever count the template suggests, and its pool choice', () => {
    expect(defaultProviders({ noun: 'barber', defaultCount: 3, pool: true })).toEqual({
      names: [''],
      pool: true,
    });
  });

  it('keeps typed names when the count changes; new lines start unnamed; stays within 1 to 20', () => {
    const typed = { names: ['Dr. Lee', 'Dr. Ng'], pool: false };
    expect(resize(typed, 3).names).toEqual(['Dr. Lee', 'Dr. Ng', '']);
    expect(resize(typed, 1).names).toEqual(['Dr. Lee']);
    expect(resize(typed, 0).names).toHaveLength(1);
    expect(resize(typed, 99).names).toHaveLength(MAX_PROVIDERS);
  });

  it('is only complete when every line has a real name', () => {
    expect(allNamed({ names: ['Sam', 'Alex'], pool: false })).toBe(true);
    expect(allNamed({ names: ['Sam', ''], pool: false })).toBe(false);
    expect(allNamed({ names: ['Sam', '   '], pool: false })).toBe(false);
  });
});

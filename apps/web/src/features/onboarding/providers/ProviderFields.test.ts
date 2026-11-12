import { describe, expect, it } from 'vitest';
import { defaultProviders, MAX_PROVIDERS, resize } from './ProviderFields.tsx';

const t = ((_: string, o: { noun: string; n: number }) => `${o.noun} ${o.n}`) as never;
const label = (n: number) => `Doctor ${n}`;

describe('provider setup', () => {
  it('starts with the template count, capitalised names and its pool choice', () => {
    expect(defaultProviders({ noun: 'doctor', defaultCount: 2, pool: true }, t)).toEqual({
      names: ['Doctor 1', 'Doctor 2'],
      pool: true,
    });
  });

  it('keeps typed names when the count changes, and stays within 1 to 20', () => {
    const typed = { names: ['Dr. Lee', 'Dr. Ng'], pool: false };
    expect(resize(typed, 3, label).names).toEqual(['Dr. Lee', 'Dr. Ng', 'Doctor 3']);
    expect(resize(typed, 1, label).names).toEqual(['Dr. Lee']);
    expect(resize(typed, 0, label).names).toHaveLength(1);
    expect(resize(typed, 99, label).names).toHaveLength(MAX_PROVIDERS);
  });
});

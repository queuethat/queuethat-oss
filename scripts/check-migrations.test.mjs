import { describe, expect, it } from 'vitest';
import { duplicatePrefixes, notAfterBase } from './check-migrations.mjs';

const base = ['20261025004700_ceiling.sql', '20261025004800_device_key.sql'];

describe('duplicatePrefixes', () => {
  it('passes distinct prefixes', () => {
    expect(duplicatePrefixes([...base, '20261025004900_new.sql'])).toEqual([]);
  });

  it('fails two migrations with the same timestamp', () => {
    const errors = duplicatePrefixes([...base, '20261025004800_other.sql']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('20261025004800_other.sql');
  });
});

describe('notAfterBase', () => {
  it('passes when nothing is new (the base branch itself)', () => {
    expect(notAfterBase(base, base)).toEqual([]);
  });

  it('passes a new migration that sorts last', () => {
    expect(notAfterBase([...base, '20261025004900_new.sql'], base)).toEqual([]);
  });

  it('fails a new migration that sorts before the newest on the base', () => {
    const errors = notAfterBase([...base, '20261025004750_late.sql'], base);
    expect(errors[0]).toContain('20261025004800_device_key.sql');
  });

  it('fails a new migration that reuses the newest timestamp', () => {
    expect(notAfterBase([...base, '20261025004800_zzz.sql'], base)).toHaveLength(1);
  });
});

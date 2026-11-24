import { describe, expect, it } from 'vitest';
import { batches, guessMapping, previewProblem, toImportRow } from './mapping.ts';

const headers = ['First Name', 'Mobile', 'E-mail', 'Country', 'Tags', 'Consent', 'Consent version'];

describe('guessMapping', () => {
  it('matches common headers and never reuses a column', () => {
    const m = guessMapping(headers);
    expect(m).toEqual({
      name: 0,
      phone: 1,
      email: 2,
      country: 3,
      tags: 4,
      consent: 5,
      consentVersion: 6,
    });
  });
  it('leaves unknown headers unmapped', () => {
    expect(guessMapping(['x']).phone).toBe(-1);
    expect(guessMapping(['Full name']).name).toBe(0);
  });
});

describe('toImportRow', () => {
  const m = guessMapping(headers);
  it('builds the RPC row and splits tags', () => {
    expect(toImportRow(['Ann', '415 555 0100', '', 'US', 'VIP; Regular', 'Yes', 'v2'], m)).toEqual({
      name: 'Ann',
      phone: '415 555 0100',
      country: 'US',
      tags: ['VIP', 'Regular'],
      transactional_consent: 'true',
      consent_text_version: 'v2',
    });
  });
  it('sends no consent key when the file has no consent column', () => {
    const row = toImportRow(['Ann', '+1 415 555 0100'], guessMapping(['Name', 'Phone']));
    expect(row).not.toHaveProperty('transactional_consent');
  });
});

describe('previewProblem', () => {
  it('flags rows the database would skip', () => {
    expect(previewProblem({ name: 'x' })).toBe('noContact');
    expect(previewProblem({ phone: '1', transactional_consent: 'true' })).toBe(
      'consentNeedsVersion',
    );
    expect(previewProblem({ email: 'a@b.co' })).toBeNull();
  });
});

describe('batches', () => {
  it('splits 2,500 rows into three calls', () => {
    const sizes = batches(Array.from({ length: 2500 }, (_, i) => i)).map((b) => b.length);
    expect(sizes).toEqual([1000, 1000, 500]);
  });
});

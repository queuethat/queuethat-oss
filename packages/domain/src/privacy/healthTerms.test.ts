import { describe, expect, it } from 'vitest';
import { findHealthTerm } from './healthTerms.ts';

describe('findHealthTerm', () => {
  it.each([
    ['Reason for visit', 'reason'],
    ['Your DOB', 'dob'],
    ['Date of birth', 'date of birth'],
    ['Any allergies?', 'allerg'],
    ['Insurance number', 'insurance'],
    ['Current medication', 'medic'],
    ['SYMPTOMS', 'symptom'],
  ])('flags %s', (label, term) => {
    expect(findHealthTerm(label)).toBe(term);
  });

  it.each(['Party name', 'Table preference', 'Phone', 'Haircut length', 'Unreasonable'])(
    'leaves %s alone',
    (label) => {
      expect(findHealthTerm(label)).toBeNull();
    },
  );

  it('uses English for a locale with no list of its own', () => {
    expect(findHealthTerm('Reason', 'de-AT')).toBe('reason');
  });
});

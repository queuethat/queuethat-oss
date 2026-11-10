import type { BuilderField, FieldType } from '../fields.ts';

/** Rough seconds a guest needs per question type; reading a heading or a tick box is quick. */
const SECONDS: Record<FieldType, number> = {
  short_text: 8,
  long_text: 20,
  single_choice: 5,
  multi_choice: 8,
  yes_no: 3,
  number: 5,
  date: 8,
  phone: 8,
  email: 8,
  heading: 2,
  marketing_consent: 2,
  agreement: 30,
  signature: 10,
};

/**
 * How long a guest needs to fill the form, in seconds, counting only what they see. Rounded up
 * to the next 5 so the sentence reads as the estimate it is; 0 when they see nothing to fill.
 */
export function fillSeconds(fields: readonly BuilderField[]): number {
  const total = fields
    .filter((f) => f.visibility !== 'staff_only')
    .reduce((sum, f) => sum + SECONDS[f.type], 0);
  return Math.ceil(total / 5) * 5;
}

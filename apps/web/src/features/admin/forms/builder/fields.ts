/** The field list shape `api.save_form_draft` stores (private.validate_form_fields owns the rules). */
export const FIELD_TYPES = [
  'short_text',
  'long_text',
  'single_choice',
  'multi_choice',
  'yes_no',
  'number',
  'date',
  'phone',
  'email',
  'heading',
  'marketing_consent',
  'agreement',
  'signature',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type Sensitivity = 'normal' | 'personal' | 'sensitive';
export type Visibility = 'guest' | 'staff_only';

export interface BuilderField {
  /** Stable answer key; set once when the field is created and never edited. */
  key: string;
  label: string;
  help?: string;
  type: FieldType;
  options?: string[];
  required?: boolean;
  visibility?: Visibility;
  sensitivity?: Sensitivity;
  /** `agreement`: the text guests read, rich-text-lite. Editing it means a new form version. */
  body?: string;
  /** `signature`: also ask for a parent or guardian name. */
  collect_guardian?: boolean;
  /** `yes_no`: only "Yes" is accepted (an age or eligibility gate); the database enforces it. */
  must_be_true?: boolean;
}

/** Guest-only consent evidence: the database stamps what was shown and when, staff never answer. */
export const isEvidence = (type: FieldType) => type === 'agreement' || type === 'signature';

/** Longest agreement text the database accepts. */
export const MAX_BODY = 8000;

/** The database refuses a 21st field; the builder stops offering one. */
export const MAX_FIELDS = 20;

export const hasOptions = (type: FieldType) => type === 'single_choice' || type === 'multi_choice';
/** Headings and the marketing consent are never required and are always shown to the guest. */
export const isStatic = (type: FieldType) => type === 'heading' || type === 'marketing_consent';

/** `short_text_1`, `short_text_2`, ...: the first key of this type not already used. */
export function nextKey(type: FieldType, taken: readonly string[]): string {
  for (let n = 1; ; n++) {
    const key = `${type}_${n}`;
    if (!taken.includes(key)) return key;
  }
}

/** A new field with the caller's already-translated label and starter options. */
export function newField(
  type: FieldType,
  taken: readonly string[],
  label: string,
  options: string[],
  body = '',
): BuilderField {
  return {
    key: nextKey(type, taken),
    label,
    type,
    ...(hasOptions(type) ? { options } : {}),
    ...(type === 'agreement' ? { body } : {}),
  };
}

/** Inserts at `index` (clamped); returns the list unchanged at the cap or for a taken key. */
export function insertField(
  fields: readonly BuilderField[],
  field: BuilderField,
  index: number,
): BuilderField[] {
  if (fields.length >= MAX_FIELDS || fields.some((f) => f.key === field.key)) return [...fields];
  const next = [...fields];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, field);
  return next;
}

/** Applies a change and drops keys holding their default so the stored shape stays minimal. */
export function patchField(field: BuilderField, patch: Partial<BuilderField>): BuilderField {
  const next = { ...field, ...patch };
  if (!next.help?.trim()) delete next.help;
  if (!next.required) delete next.required;
  if (next.visibility === 'guest') delete next.visibility;
  if (next.sensitivity === 'normal') delete next.sensitivity;
  if (!next.collect_guardian) delete next.collect_guardian;
  if (!next.must_be_true) delete next.must_be_true;
  return next;
}

/** One option per line; blank lines dropped. */
export const parseOptions = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export type FieldWarning = 'sensitive' | 'sensitive_health';

/**
 * Plain-language cautions for a field's sensitivity class (C5). The database stays the owner of
 * the hard blocks (card and SIN/SSN numbers, the privacy contact); these only tell the owner why.
 */
export function fieldWarnings(field: BuilderField, healthTagged: boolean): FieldWarning[] {
  if (field.sensitivity !== 'sensitive') return [];
  return healthTagged ? ['sensitive', 'sensitive_health'] : ['sensitive'];
}

/** Light checks the owner can fix before saving; the database re-checks everything. */
export function fieldProblems(
  field: BuilderField,
): Array<'label' | 'options' | 'duplicate' | 'body' | 'markup'> {
  const problems: Array<'label' | 'options' | 'duplicate' | 'body' | 'markup'> = [];
  if (!field.label.trim()) problems.push('label');
  if (hasOptions(field.type)) {
    const options = field.options ?? [];
    if (options.length === 0) problems.push('options');
    else if (new Set(options).size !== options.length) problems.push('duplicate');
  }
  if (field.type === 'agreement') {
    const body = field.body ?? '';
    if (!body.trim()) problems.push('body');
    else if (/[<>]/.test(body)) problems.push('markup');
  }
  return problems;
}

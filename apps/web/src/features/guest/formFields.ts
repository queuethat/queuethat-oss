import type { Answers } from './api.ts';

/** Field types `get_join_form` publishes (canonical vocabulary, B2 library). */
export type FormFieldType =
  | 'short_text'
  | 'long_text'
  | 'single_choice'
  | 'multi_choice'
  | 'yes_no'
  | 'number'
  | 'date'
  | 'phone'
  | 'email'
  | 'heading'
  | 'marketing_consent'
  | 'agreement'
  | 'signature';

/** One guest-visible field as the database publishes it. */
export interface FormField {
  key: string;
  label: string;
  help: string | null;
  type: FormFieldType;
  options: string[];
  required: boolean;
  /** `agreement`: the text to read, rich-text-lite (see `parseRichText`). Never HTML. */
  body?: string;
  /** `signature`: whether to also ask for a parent or guardian name. */
  collectGuardian?: boolean;
}

/** What the form holds per key: text, a ticked box, or the ticked options of a multi_choice. */
export type FormDraft = Record<string, string | boolean | string[]>;

/** Draft key of a signature's guardian name; the signer's own name is held under the field key. */
export const guardianKey = (key: string) => `${key}.guardian`;

const TYPES = new Set<string>([
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
]);

/**
 * `get_join_form` as typed fields, in the order published. Anything malformed or of a type this
 * build cannot draw is dropped rather than rendered; the database still validates what is sent.
 */
export function parseJoinForm(json: unknown): FormField[] {
  const raw = (json as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): FormField[] => {
    const f = item as Record<string, unknown> | null;
    if (!f || typeof f.key !== 'string' || typeof f.label !== 'string') return [];
    if (typeof f.type !== 'string' || !TYPES.has(f.type)) return [];
    return [
      {
        key: f.key,
        label: f.label,
        help: typeof f.help === 'string' ? f.help : null,
        type: f.type as FormFieldType,
        options: Array.isArray(f.options) ? f.options.map(String) : [],
        required: f.required === true,
        ...(f.type === 'agreement' && typeof f.body === 'string' ? { body: f.body } : {}),
        ...(f.type === 'signature' && f.collect_guardian === true ? { collectGuardian: true } : {}),
      },
    ];
  });
}

/**
 * `p_answers`: only what the guest filled in, typed as the database expects. It never decides
 * whether a field is required or valid; a blank is simply not sent and the database refuses a
 * missing required answer by key.
 */
export function formAnswers(fields: readonly FormField[], draft: FormDraft): Answers {
  const out: Answers = {};
  for (const f of fields) {
    const value = draft[f.key];
    switch (f.type) {
      case 'heading':
        break;
      case 'yes_no':
      case 'marketing_consent':
        if (typeof value === 'boolean') out[f.key] = value;
        break;
      case 'agreement':
        // Only a ticked box is acceptance; an unticked one is simply not sent.
        if (value === true) out[f.key] = true;
        break;
      case 'signature': {
        // The database stamps when and what was signed; only the typed names are ours to send.
        const name = typeof value === 'string' ? value.trim() : '';
        if (name === '') break;
        const g = draft[guardianKey(f.key)];
        const guardian = f.collectGuardian && typeof g === 'string' ? g.trim() : '';
        out[f.key] = guardian ? { name, guardian_name: guardian } : { name };
        break;
      }
      case 'multi_choice':
        if (Array.isArray(value) && value.length > 0) out[f.key] = value;
        break;
      case 'number':
        if (typeof value === 'string' && value.trim() !== '') out[f.key] = Number(value);
        break;
      default:
        if (typeof value === 'string' && value.trim() !== '') out[f.key] = value.trim();
    }
  }
  return out;
}

/** Moves focus to the control of a field, e.g. the one the database named in `invalid_answers`. */
export function focusAnswer(key: string): void {
  document.querySelector<HTMLElement>(`[name="answer.${CSS.escape(key)}"]`)?.focus();
}

/** The draft that would produce `answers`: for a form shown again after the database refused some. */
export function draftFrom(fields: readonly FormField[], answers: Answers): FormDraft {
  const out: FormDraft = {};
  for (const f of fields) {
    const v = answers[f.key];
    if (v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      out[f.key] = v.name;
      if (v.guardian_name) out[guardianKey(f.key)] = v.guardian_name;
      continue;
    }
    out[f.key] = typeof v === 'number' ? String(v) : v;
  }
  return out;
}

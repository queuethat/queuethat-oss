import type { IntakeFieldDef } from './IntakeField.tsx';

/** One intake question as the database publishes it (api.get_location_wait / app.intake_fields). */
export type IntakeField = IntakeFieldDef;

/** What the form holds per key, as the shared renderer does: text, or 'true' for a ticked box. */
export type Draft = Record<string, string>;
export type Answers = Record<string, string | number | boolean>;

const TYPES = new Set(['text', 'select', 'checkbox', 'phone', 'number', 'date']);

/** The published jsonb as typed fields; anything malformed is dropped rather than rendered. */
export function parseFields(json: unknown): IntakeField[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((raw): IntakeField[] => {
    const f = raw as Partial<IntakeField> | null;
    if (
      !f ||
      typeof f.key !== 'string' ||
      typeof f.label !== 'string' ||
      !TYPES.has(f.type ?? '')
    ) {
      return [];
    }
    return [
      {
        key: f.key,
        label: f.label,
        help: f.help ?? null,
        type: f.type!,
        options: Array.isArray(f.options) ? f.options.map(String) : null,
        required: f.required === true,
      },
    ];
  });
}

/** Blank text and an unchecked box count as not answered, as the database counts them. */
export function isBlank(field: IntakeField, value: string | undefined): boolean {
  return field.type === 'checkbox' ? value !== 'true' : (value ?? '').trim() === '';
}

/** The first required field left blank, so the form can focus it before anything is sent. */
export function firstMissing(fields: IntakeField[], draft: Draft): IntakeField | null {
  return fields.find((f) => f.required && isBlank(f, draft[f.key])) ?? null;
}

/** `p_answers`: only the answered fields, numbers as numbers. The database validates the rest. */
export function answersPayload(fields: IntakeField[], draft: Draft): Answers {
  const out: Answers = {};
  for (const f of fields) {
    const value = draft[f.key];
    if (isBlank(f, value)) continue;
    out[f.key] =
      f.type === 'number' ? Number(value) : f.type === 'checkbox' ? true : String(value).trim();
  }
  return out;
}

/** The form control for a key, for moving focus to the first problem. */
export function focusField(key: string): void {
  document.querySelector<HTMLElement>(`[name="intake.${CSS.escape(key)}"]`)?.focus();
}

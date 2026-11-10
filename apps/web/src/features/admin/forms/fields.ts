import type { BuilderField, FieldType, Sensitivity, Visibility } from './builder/fields.ts';
import { FIELD_TYPES } from './builder/fields.ts';

const LEGACY_TYPES: Record<string, FieldType> = {
  text: 'short_text',
  select: 'single_choice',
  checkbox: 'yes_no',
};

const SENSITIVITIES: Sensitivity[] = ['normal', 'personal', 'sensitive'];

/**
 * A stored form version's `fields` as the builder edits them. Versions saved before the field
 * vocabulary was unified still carry text, select and checkbox; they open as their canonical
 * types. Anything the builder cannot draw is dropped rather than guessed at.
 */
export function fromStored(raw: unknown): BuilderField[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): BuilderField[] => {
    const f = item as Record<string, unknown> | null;
    if (!f || typeof f.key !== 'string' || typeof f.label !== 'string') return [];
    const type = (LEGACY_TYPES[f.type as string] ?? f.type) as FieldType;
    if (!FIELD_TYPES.includes(type)) return [];
    return [
      {
        key: f.key,
        label: f.label,
        type,
        ...(typeof f.help === 'string' && f.help ? { help: f.help } : {}),
        ...(Array.isArray(f.options) ? { options: f.options.map(String) } : {}),
        ...(f.required === true ? { required: true } : {}),
        ...(type === 'agreement' && typeof f.body === 'string' ? { body: f.body } : {}),
        ...(type === 'signature' && f.collect_guardian === true ? { collect_guardian: true } : {}),
        ...(f.visibility === 'staff_only' ? { visibility: 'staff_only' as Visibility } : {}),
        ...(SENSITIVITIES.includes(f.sensitivity as Sensitivity)
          ? { sensitivity: f.sensitivity as Sensitivity }
          : {}),
      },
    ];
  });
}

/** Fields as `api.save_form_draft` takes them. Array order is field order; labels are trimmed. */
export const fieldsPayload = (fields: BuilderField[]) =>
  fields.map((f) => ({ ...f, label: f.label.trim() }));

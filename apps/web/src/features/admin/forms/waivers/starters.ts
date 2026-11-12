import activityCentre from '../../../../../../../supabase/catalog/waivers/activity_centre.json';
import spa from '../../../../../../../supabase/catalog/waivers/spa.json';
import tattoo from '../../../../../../../supabase/catalog/waivers/tattoo.json';
import type { BuilderField, FieldType } from '../builder/fields.ts';

/** Text the catalog carries in every guest language. */
type Localized = { en: string; es: string };

/**
 * One starter waiver as stored in `supabase/catalog/waivers/<key>.json` (`CatalogWaiver` in
 * `packages/domain/src/templates/catalog.ts`, whose lint runs in ci:local and requires the
 * "not legal advice" banner).
 */
export interface StarterFile {
  key: string;
  version: number;
  name: Localized;
  description?: Localized;
  form: {
    name: Localized;
    fields: Array<{
      key: string;
      type: string;
      required?: boolean;
      collect_guardian?: boolean;
      label: Localized;
      body?: Localized;
    }>;
  };
  waiver_banner: Localized;
}

/** What the form editor opens with when an owner starts from a sample. */
export interface StarterForm {
  key: string;
  name: string;
  purposeText: string;
  fields: BuilderField[];
}

/** The generic starters (W6), in the order the forms page offers them. */
export const STARTERS: readonly StarterFile[] = [tattoo, activityCentre, spa] as StarterFile[];

/**
 * A starter in the owner's language (Spanish when the admin runs in Spanish, English otherwise),
 * as an unsaved form. The owner edits it like any form; nothing is stored until they save, and the
 * copy never changes when the sample text does.
 */
export function starterForm(key: string, language: string): StarterForm | null {
  const file = STARTERS.find((s) => s.key === key);
  if (!file) return null;
  const lang: keyof Localized = language.startsWith('es') ? 'es' : 'en';
  return {
    key: file.key,
    name: file.form.name[lang],
    purposeText: file.description?.[lang] ?? '',
    fields: file.form.fields.map((f) => ({
      key: f.key,
      type: f.type as FieldType,
      label: f.label[lang],
      ...(f.body ? { body: f.body[lang] } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.collect_guardian ? { collect_guardian: true } : {}),
    })),
  };
}

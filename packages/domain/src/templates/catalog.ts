/**
 * Content rules for the template catalog (T2, #1296): the shape of a `supabase/catalog/<key>.json`
 * file and the lint `scripts/check-templates.ts` runs over every file in `pnpm ci:local`.
 *
 * The file is the catalog row's `payload` (plus key, version, tier, mode, health_tagged, which become
 * the row's columns), so a content migration embeds it verbatim. Every guest- or owner-facing string
 * is localized as `{ en, es }`: guest pages promise English and Spanish. Pure and dependency-free.
 */

/** A string in every language the guest pages promise. */
export interface Localized {
  en: string;
  es: string;
}

export interface CatalogService {
  name: Localized;
  /** Expected minutes; drives the ETA, so it is mandatory. */
  minutes: number;
  prefix?: string;
}

export interface CatalogQueue {
  name: Localized;
  prefix: string;
  show_eta: boolean;
  party_min?: number;
  party_max?: number;
  services: CatalogService[];
}

export interface CatalogResource {
  label: Localized;
  kind: 'counter' | 'desk' | 'room' | 'table' | 'chair' | 'staff';
  seats?: number;
}

/** One field of the template's default form, in the forms engine's canonical vocabulary. */
export interface CatalogField {
  key: string;
  type: string;
  label: Localized;
  help?: Localized;
  options?: Localized[];
  /** Agreement text (rich-text-lite), only on `agreement` fields. */
  body?: Localized;
  required?: boolean;
  must_be_true?: boolean;
  collect_guardian?: boolean;
  sensitivity?: 'normal' | 'personal' | 'sensitive';
  visibility?: string;
}

export interface CatalogForm {
  name: Localized;
  fields: CatalogField[];
}

/** Multi-provider setup (T4): "How many doctors?" creates that many personal lines plus a pool. */
export interface CatalogProviders {
  /** What one provider is called, singular: "doctor", "barber". */
  noun: Localized;
  default_count: number;
  /** Offer the optional "Anyone available" pooled line. */
  pool: boolean;
}

export interface CatalogTemplate {
  key: string;
  version: number;
  tier: 1 | 2 | 3;
  mode: 'walk_in' | 'booking' | 'both';
  health_tagged: boolean;
  name: Localized;
  description: Localized;
  /** Search words for the "What kind of business?" picker, per language: "haircut", "fade". */
  keywords?: { en: string[]; es: string[] };
  queues: CatalogQueue[];
  resources: CatalogResource[];
  providers?: CatalogProviders;
  form?: CatalogForm;
  /** Required whenever the form has an agreement: the "not legal advice" banner. */
  waiver_banner?: Localized;
  /** Booking settings; their shape belongs to the booking module, the lint only checks it is an object. */
  booking?: Record<string, unknown>;
}

/** Most optional questions a template form may ask (design 2.4): every extra one costs guests. */
export const MAX_OPTIONAL_QUESTIONS = 3;

/**
 * Health-class verticals: they must carry the clinical-safety flags whatever the author sets.
 * A key is health-class when it is listed here or declares `health_tagged`.
 */
export const HEALTH_CLASS_KEYS: readonly string[] = [
  'clinic',
  'walk_in_clinic',
  'family_practice',
  'dental',
  'physio',
  'physio_chiro',
  'veterinary',
  'pharmacy',
  'urgent_care',
  'optometry',
];

/** The banner every waiver starter shows; the English text must contain this phrase. */
export const WAIVER_BANNER_PHRASE = 'not legal advice';

/** Field types that ask the guest something (headings, agreements and consent are not questions). */
const QUESTION_TYPES = new Set([
  'short_text',
  'long_text',
  'single_choice',
  'multi_choice',
  'yes_no',
  'number',
  'date',
  'phone',
  'email',
]);
const FIELD_TYPES = new Set([
  ...QUESTION_TYPES,
  'heading',
  'marketing_consent',
  'agreement',
  'signature',
]);
const RESOURCE_KINDS = new Set(['counter', 'desk', 'room', 'table', 'chair', 'staff']);
const PREFIX = /^[A-Z]{1,3}$/;
const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: Json, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * Every problem with one catalog file, as human-readable lines prefixed with the JSON path.
 * Empty means the template may ship. `fileKey` is the file name without `.json`; it must match `key`.
 */
export function lintTemplate(tpl: Json, fileKey?: string): string[] {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);

  const text = localizedChecker(err);

  if (!isObject(tpl)) return ['$: a template is a JSON object'];
  const t = tpl;
  if (typeof t.key !== 'string' || !KEY.test(t.key))
    err('key', 'lower_snake_case, 2-40 characters');
  if (fileKey !== undefined && t.key !== fileKey)
    err('key', `must match the file name "${fileKey}"`);
  if (!isInt(t.version, 1, 1000)) err('version', 'a whole number from 1');
  if (!isInt(t.tier, 1, 3)) err('tier', '1, 2 or 3');
  if (!['walk_in', 'booking', 'both'].includes(t.mode as string))
    err('mode', 'walk_in, booking or both');
  if (typeof t.health_tagged !== 'boolean') err('health_tagged', 'true or false');
  text(t.name, 'name');
  text(t.description, 'description');
  if (t.keywords !== undefined) {
    const kw = t.keywords;
    for (const lang of ['en', 'es'] as const) {
      const list = isObject(kw) ? kw[lang] : undefined;
      if (!Array.isArray(list) || list.some((w) => typeof w !== 'string' || !w.trim()))
        err(`keywords.${lang}`, `missing ${lang.toUpperCase()} keywords`);
    }
  }

  if (!Array.isArray(t.queues) || t.queues.length === 0) err('queues', 'at least one queue');
  else
    t.queues.forEach((q: Json, i) => {
      const p = `queues[${i}]`;
      if (!isObject(q)) return err(p, 'must be an object');
      text(q.name, `${p}.name`);
      if (typeof q.prefix !== 'string' || !PREFIX.test(q.prefix))
        err(`${p}.prefix`, '1-3 capitals');
      if (typeof q.show_eta !== 'boolean') err(`${p}.show_eta`, 'true or false');
      if (!Array.isArray(q.services) || q.services.length === 0)
        return err(`${p}.services`, 'at least one service');
      q.services.forEach((s: Json, j) => {
        const sp = `${p}.services[${j}]`;
        if (!isObject(s)) return err(sp, 'must be an object');
        text(s.name, `${sp}.name`);
        if (!isInt(s.minutes, 1, 480))
          err(`${sp}.minutes`, 'service needs a duration of 1-480 minutes');
        if (s.prefix !== undefined && (typeof s.prefix !== 'string' || !PREFIX.test(s.prefix)))
          err(`${sp}.prefix`, '1-3 capitals');
      });
    });

  if (!Array.isArray(t.resources)) err('resources', 'an array (may be empty)');
  else
    t.resources.forEach((r: Json, i) => {
      const p = `resources[${i}]`;
      if (!isObject(r)) return err(p, 'must be an object');
      text(r.label, `${p}.label`);
      if (!RESOURCE_KINDS.has(r.kind as string)) err(`${p}.kind`, [...RESOURCE_KINDS].join(', '));
      if (r.seats !== undefined && !isInt(r.seats, 1, 50)) err(`${p}.seats`, '1-50');
    });

  if (t.providers !== undefined) {
    const pr = t.providers;
    if (!isObject(pr)) err('providers', 'must be an object');
    else {
      text(pr.noun, 'providers.noun');
      if (!isInt(pr.default_count, 1, 20)) err('providers.default_count', '1-20');
      if (typeof pr.pool !== 'boolean') err('providers.pool', 'true or false');
    }
  }
  if (t.booking !== undefined && !isObject(t.booking)) err('booking', 'must be an object');

  const fields = lintForm(t.form, err, text);

  const hasAgreement = fields.some((f) => f.type === 'agreement');
  if (hasAgreement || t.waiver_banner !== undefined) lintBanner(t.waiver_banner, err, text);

  // Clinical safety (design section 4): health-class templates tag the org (names off displays, no
  // service text in messages) and keep sensitive answers to a short reason, never clinical detail.
  if (
    typeof t.key === 'string' &&
    (HEALTH_CLASS_KEYS.includes(t.key) || t.health_tagged === true)
  ) {
    if (t.health_tagged !== true)
      err('health_tagged', 'a health-class vertical must be health_tagged');
    fields.forEach((f, i) => {
      if (f.type === 'long_text') err(`form.fields[${i}]`, 'health-class forms take no long_text');
      if (f.sensitivity === 'sensitive' && f.type !== 'short_text')
        err(`form.fields[${i}]`, 'a sensitive answer in a health-class form must be short_text');
      if (QUESTION_TYPES.has(f.type as string) && f.sensitivity === undefined)
        err(`form.fields[${i}].sensitivity`, 'health-class questions declare their sensitivity');
    });
  }
  return errors;
}

/** A starter waiver in `supabase/catalog/waivers/<key>.json` (W6): a form with an agreement, plus the banner. */
export interface CatalogWaiver {
  key: string;
  version: number;
  name: Localized;
  description?: Localized;
  form: CatalogForm;
  waiver_banner: Localized;
}

/** Every problem with one starter waiver file; see lintTemplate. */
export function lintWaiver(w: Json, fileKey?: string): string[] {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);
  const text = localizedChecker(err);
  if (!isObject(w)) return ['$: a waiver is a JSON object'];
  if (typeof w.key !== 'string' || !KEY.test(w.key))
    err('key', 'lower_snake_case, 2-40 characters');
  if (fileKey !== undefined && w.key !== fileKey)
    err('key', `must match the file name "${fileKey}"`);
  if (!isInt(w.version, 1, 1000)) err('version', 'a whole number from 1');
  text(w.name, 'name');
  text(w.description, 'description', false);
  const fields = lintForm(w.form, err, text);
  if (w.form === undefined) err('form', 'required');
  else if (!fields.some((f) => f.type === 'agreement'))
    err('form.fields', 'a waiver needs an agreement');
  lintBanner(w.waiver_banner, err, text);
  return errors;
}

function localizedChecker(err: (path: string, msg: string) => void) {
  return (v: Json, path: string, required = true) => {
    if (v === undefined && !required) return;
    if (!isObject(v)) return err(path, 'must be {"en": ..., "es": ...}');
    for (const lang of ['en', 'es'] as const) {
      const s = v[lang];
      if (typeof s !== 'string' || !s.trim()) err(path, `missing ${lang.toUpperCase()} string`);
    }
  };
}

function lintBanner(
  banner: Json,
  err: (path: string, msg: string) => void,
  text: (v: Json, path: string, required?: boolean) => void,
) {
  text(banner, 'waiver_banner');
  const en = isObject(banner) ? banner.en : undefined;
  if (typeof en !== 'string' || !en.toLowerCase().includes(WAIVER_BANNER_PHRASE))
    err('waiver_banner', `a waiver needs the "${WAIVER_BANNER_PHRASE}" banner`);
}

function lintForm(
  form: Json,
  err: (path: string, msg: string) => void,
  text: (v: Json, path: string, required?: boolean) => void,
): Record<string, Json>[] {
  if (form === undefined) return [];
  if (!isObject(form)) {
    err('form', 'must be an object');
    return [];
  }
  text(form.name, 'form.name');
  if (!Array.isArray(form.fields) || form.fields.length === 0 || form.fields.length > 20) {
    err('form.fields', '1-20 fields');
    return [];
  }
  const fields = form.fields.filter(isObject);
  const keys = new Set<string>();
  let optional = 0;
  form.fields.forEach((f: Json, i) => {
    const p = `form.fields[${i}]`;
    if (!isObject(f)) return err(p, 'must be an object');
    if (typeof f.key !== 'string' || !FIELD_KEY.test(f.key)) err(`${p}.key`, 'lower_snake_case');
    else if (keys.has(f.key)) err(`${p}.key`, 'duplicate');
    else keys.add(f.key);
    if (!FIELD_TYPES.has(f.type as string))
      err(`${p}.type`, `one of ${[...FIELD_TYPES].join(', ')}`);
    text(f.label, `${p}.label`);
    text(f.help, `${p}.help`, false);
    const choice = f.type === 'single_choice' || f.type === 'multi_choice';
    if (choice !== (f.options !== undefined))
      err(`${p}.options`, 'only and always on choice fields');
    if (Array.isArray(f.options)) f.options.forEach((o: Json, j) => text(o, `${p}.options[${j}]`));
    else if (f.options !== undefined) err(`${p}.options`, 'an array');
    if (f.type === 'agreement') text(f.body, `${p}.body`);
    if (f.type === 'marketing_consent' && f.required === true)
      err(`${p}.required`, 'marketing consent is never required');
    if (QUESTION_TYPES.has(f.type as string) && f.required !== true) optional++;
  });
  if (optional > MAX_OPTIONAL_QUESTIONS)
    err('form.fields', `${optional} optional questions; at most ${MAX_OPTIONAL_QUESTIONS}`);
  if (fields.some((f) => f.type === 'signature') && !fields.some((f) => f.type === 'agreement'))
    err('form.fields', 'a signature needs an agreement');
  return fields;
}

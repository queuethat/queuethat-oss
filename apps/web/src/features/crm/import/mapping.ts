/** The fields an import file can fill; `api.import_guests` reads them by these row keys. */
export const IMPORT_FIELDS = [
  'name',
  'phone',
  'email',
  'country',
  'tags',
  'consent',
  'consentVersion',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
/** Column index per field; -1 leaves a field unmapped. */
export type Mapping = Record<ImportField, number>;

/** Rows per `api.import_guests` call (the database accepts at most 1000). */
export const BATCH_SIZE = 1000;

const GUESS: Record<ImportField, RegExp> = {
  name: /^((first|full|guest)[ _]?)?name$|^guest$/i,
  phone: /phone|mobile|cell|tel/i,
  email: /e-?mail/i,
  country: /country/i,
  tags: /tags?|labels?/i,
  consent: /consent|opt[ _-]?in/i,
  consentVersion: /(consent|terms).*(version|text)|version/i,
};

const GUESS_ORDER: ImportField[] = [
  'consentVersion',
  'consent',
  'name',
  'phone',
  'email',
  'country',
  'tags',
];

/** First header matching each field; a column is used at most once. */
export function guessMapping(headers: string[]): Mapping {
  const used = new Set<number>();
  const mapping = {} as Mapping;
  // The version column is claimed before `consent`, whose pattern would also match it.
  for (const field of GUESS_ORDER) {
    const index = headers.findIndex((h, i) => !used.has(i) && GUESS[field].test(h.trim()));
    mapping[field] = index;
    if (index >= 0) used.add(index);
  }
  return mapping;
}

export interface ImportRow {
  name?: string;
  phone?: string;
  email?: string;
  country?: string;
  tags?: string[];
  transactional_consent?: 'true' | 'false';
  consent_text_version?: string;
}

const YES = /^(y|yes|true|1)$/i;

/** One file row as the RPC's row object; empty cells are left out. */
export function toImportRow(cells: string[], mapping: Mapping): ImportRow {
  const cell = (f: ImportField) => (mapping[f] >= 0 ? (cells[mapping[f]] ?? '').trim() : '');
  const row: ImportRow = {};
  if (cell('name')) row.name = cell('name');
  if (cell('phone')) row.phone = cell('phone');
  if (cell('email')) row.email = cell('email');
  if (cell('country')) row.country = cell('country');
  const tags = cell('tags')
    .split(/[;|]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (tags.length) row.tags = tags;
  if (mapping.consent >= 0)
    row.transactional_consent = YES.test(cell('consent')) ? 'true' : 'false';
  if (cell('consentVersion')) row.consent_text_version = cell('consentVersion');
  return row;
}

/** The problem the preview shows for a row, or null. The database re-checks everything. */
export function previewProblem(row: ImportRow): 'noContact' | 'consentNeedsVersion' | null {
  if (!row.phone && !row.email) return 'noContact';
  if (row.transactional_consent === 'true' && !row.consent_text_version)
    return 'consentNeedsVersion';
  return null;
}

/** Splits rows into calls of at most `size`. */
export function batches<T>(rows: T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

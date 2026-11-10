/**
 * Words in an intake question that suggest it collects health information (Q-8). The builder
 * warns when a label matches; it never blocks, because a clinic may ask on purpose. Stems match
 * the start of a word ("allerg" finds "allergies"); a locale adds its own list here.
 */
const HEALTH_STEMS: Record<string, readonly string[]> = {
  en: [
    'symptom',
    'reason',
    'condition',
    'medic',
    'insurance',
    'dob',
    'date of birth',
    'birth',
    'diagnos',
    'allerg',
    'prescription',
    'pregnan',
    'illness',
    'treatment',
    'injur',
    'health',
  ],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first health term found in `label`, or null. Falls back to English for a locale without a
 * list of its own.
 */
export function findHealthTerm(label: string, locale = 'en'): string | null {
  const stems = HEALTH_STEMS[locale.split('-')[0] ?? 'en'] ?? HEALTH_STEMS.en!;
  const text = label.toLowerCase();
  for (const stem of stems) {
    if (new RegExp(`(^|[^\\p{L}])${escape(stem)}`, 'u').test(text)) return stem;
  }
  return null;
}

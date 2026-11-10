/** api.eta_state. The database decides it (private.eta_at); clients only render it. */
export type EtaState =
  'hidden' | 'paused' | 'unstaffed' | 'next' | 'over_hour' | 'uncertain' | 'ok' | 'override';

/** An i18next-compatible translate function. */
export type Translate = (key: string, vars?: Record<string, unknown>) => string;

/**
 * English for the `eta` namespace (technical-design.md 8). The i18n scaffold registers these;
 * other locales translate the same keys.
 */
export const ETA_MESSAGES_EN = {
  'eta.paused': 'Your place is kept',
  'eta.unstaffed': 'Waiting for staff to start',
  'eta.next': "You're next",
  'eta.over_hour': 'Over an hour',
  'eta.uncertain': 'Wait time uncertain',
  'eta.ok': 'About {{low}}–{{high}} min',
} as const;

/**
 * The label for an estimate from the database, or null when it shows nothing (hidden: position
 * only, or no state at all for a visit that is no longer waiting). Renders the numbers exactly
 * as given; staleness ("as of") is the caller's, from the snapshot's as_of.
 */
export function formatEta(
  state: EtaState | null,
  low: number | null,
  high: number | null,
  t: Translate,
): string | null {
  if (state === null || state === 'hidden') return null;
  // A staff override is shown like any estimate: the range is the database's, only the cause differs.
  return state === 'ok' || state === 'override' ? t('eta.ok', { low, high }) : t(`eta.${state}`);
}

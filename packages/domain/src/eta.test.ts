import { describe, expect, it } from 'vitest';
import { ETA_MESSAGES_EN, formatEta, type EtaState, type Translate } from './eta.ts';

/** Looks keys up in the English catalogue and fills {{vars}}, as i18next does. */
const t: Translate = (key, vars = {}) =>
  ETA_MESSAGES_EN[key as keyof typeof ETA_MESSAGES_EN].replace(
    /\{\{(\w+)\}\}/g,
    (_, name: string) => String(vars[name]),
  );

describe('formatEta', () => {
  it.each<[EtaState, number | null, number | null, string | null]>([
    ['hidden', null, null, null],
    ['paused', null, null, 'Your place is kept'],
    ['unstaffed', null, null, 'Waiting for staff to start'],
    ['next', 0, 10, "You're next"],
    ['over_hour', 60, 130, 'Over an hour'],
    ['uncertain', 35, 125, 'Wait time uncertain'],
    ['ok', 10, 20, 'About 10–20 min'],
    ['override', 10, 20, 'About 10–20 min'],
  ])('renders %s with the design doc wording', (state, low, high, label) => {
    expect(formatEta(state, low, high, t)).toBe(label);
  });

  it('shows the numbers exactly as the database sent them', () => {
    expect(formatEta('ok', 7, 7, t)).toBe('About 7–7 min');
  });

  it('shows nothing for a visit with no estimate', () => {
    expect(formatEta(null, null, null, t)).toBeNull();
  });
});

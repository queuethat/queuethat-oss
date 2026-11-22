import type { BusinessSetup } from './api.ts';

const KEY = 'qm.onboarding.draft';

/** What a reload mid-wizard brings back: the step, everything typed, and whether blank was chosen. */
export interface Draft {
  step: number;
  setup: BusinessSetup;
  blank: boolean;
}

const text = (v: unknown): v is string => typeof v === 'string';

/** The saved draft, or null when there is none or it is not ours (a different shape or version). */
export function loadDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    const s = d.setup;
    if (!s || ![1, 2, 3].includes(d.step ?? 0)) return null;
    const ok =
      text(s.businessName) &&
      text(s.locationName) &&
      text(s.address) &&
      text(s.timeZone) &&
      text(s.queueName) &&
      text(s.serviceName) &&
      typeof s.expectedMinutes === 'number' &&
      (s.templateKey === null || text(s.templateKey));
    return ok ? { step: d.step!, setup: s, blank: d.blank === true } : null;
  } catch {
    return null;
  }
}

/** Keeps the draft for this tab only (sessionStorage); it survives a reload, not a new session. */
export function saveDraft(draft: Draft) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Storage can be blocked; the wizard works without it.
  }
}

/** Forgets the draft once the business exists. */
export function clearDraft() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

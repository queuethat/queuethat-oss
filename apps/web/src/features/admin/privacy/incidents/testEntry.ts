import type { LogEntry } from './api.ts';

/** A log row for tests: a manual entry unless `over` says otherwise. */
export const entry = (over: Partial<LogEntry>): LogEntry => ({
  id: crypto.randomUUID(),
  org_id: 'org-a',
  source: 'manual',
  created_at: '2026-11-09T00:00:00Z',
  created_by: null,
  updated_at: '2026-11-09T00:00:00Z',
  incident_id: null,
  notice_id: null,
  notice_subject: null,
  notice_body: null,
  notice_sent_at: null,
  acknowledged_at: null,
  acknowledged_by: null,
  kind: 'data_exposure',
  title: 'Tablet left unlocked',
  description: null,
  data_categories: ['contact'],
  detected_at: '2026-11-09T00:00:00Z',
  people_affected: null,
  actions_taken: null,
  regulator_notified: null,
  ...over,
});

// Contract shared by the CRM and POS sync adapters (Square #395, HubSpot #396). The integration-sync
// Edge Function claims jobs (api.claim_integration_jobs), hands each to the adapter named by its
// provider and reports the outcome. An adapter only talks to its vendor; consent, retries and dead
// letter belong to the database, so an adapter never decides who may be synced.

export interface IntegrationContact {
  channel: 'phone' | 'email';
  /** E.164 for a phone, a lower-case address for an email. */
  value: string;
  name: string | null;
}

export interface IntegrationVisit {
  id: string;
  ticket: string;
  queue: string;
  joined_at: string | null;
  serving_at: string | null;
  finished_at: string | null;
}

/** One row of api.claim_integration_jobs. Secrets live in function memory for one invocation. */
export interface IntegrationJob {
  id: string;
  org_id: string;
  channel: 'pos' | 'crm';
  provider: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  attempts: number;
  visit: IntegrationVisit;
  contact: IntegrationContact;
}

/** Tokens an adapter refreshed while syncing; the runner stores them with api.save_integration_tokens. */
export interface RefreshedTokens {
  secrets: Record<string, string>;
  config: Record<string, unknown>;
}

export type SyncResult =
  | { status: 'delivered'; refreshed?: RefreshedTokens }
  /** `error` is a short code (http_500, unauthorized), never a vendor response body. */
  | { status: 'failed'; error: string; retryable: boolean; refreshed?: RefreshedTokens };

export interface IntegrationAdapter {
  provider: string;
  sync(job: IntegrationJob): Promise<SyncResult>;
}

/**
 * Cleans a guest-typed value before it goes to a vendor: control and invisible/bidi format characters become spaces,
 * and a leading =, +, - or @ is dropped so a spreadsheet export of the vendor's records cannot run it as a formula.
 */
export function cleanText(value: string | null | undefined, max: number): string {
  const plain = (value ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.replace(/^[=+\-@\s]+/, '').slice(0, max);
}

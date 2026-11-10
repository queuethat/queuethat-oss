/** What the delivery log says about an error code or suppression reason, as a translation key. */
export interface Reason {
  /** Key under `deliveries.reasons` in the platform namespace. */
  key: string;
  /** Interpolation values for the key. */
  values: { status?: string; code?: string };
}

const KNOWN = new Set([
  'blocked',
  'bot_blocked',
  'cap_reached',
  'channel_disabled',
  'complaint',
  'delivery_error',
  'invalid_number',
  'invalid_recipient',
  'lease_expired',
  'missing_postal_address',
  'missing_unsubscribe',
  'network_error',
  'no_approved_template',
  'no_channel',
  'no_consent',
  'no_marketing_consent',
  'no_template',
  'not_relevant',
  'plan_limit_reached',
  'quiet_hours',
  'rate_limited',
  'recipient_deleted',
  'suppressed',
  'timeout',
  'unsubscribed',
  'unsupported_recipient',
]);

/** Suppression-list reasons (`app.suppressions.reason`) the log can name. */
const SUPPRESSION = new Set(['stop', 'bounce', 'complaint', 'manual', 'platform_stop']);

/**
 * Plain-language wording for a row's error code, preferring the suppression-list reason when the
 * recipient is on the org's list ("opted out with STOP"). Unknown codes are shown as they are so
 * an agent can still search for them; null when there is nothing to explain.
 */
export function reasonOf(row: {
  error_code: string | null;
  suppression_reason: string | null;
}): Reason | null {
  if (row.suppression_reason && SUPPRESSION.has(row.suppression_reason)) {
    return { key: `suppression.${row.suppression_reason}`, values: {} };
  }
  const code = row.error_code;
  if (!code) return null;
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return { key: 'http', values: { status: http[1]! } };
  if (KNOWN.has(code)) return { key: code, values: {} };
  return { key: 'other', values: { code } };
}

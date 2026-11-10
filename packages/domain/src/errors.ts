/**
 * Stable error codes raised by the database. api.* functions raise them as the exception
 * message (SQLSTATE P0001); permission failures arrive as SQLSTATE 42501. This is the only place
 * clients map database errors, so screens switch on an ErrorCode, never on message text.
 */
export const ERROR_CODES = [
  'queue_not_accepting',
  'org_suspended',
  'capacity_reached',
  'rate_limited',
  'captcha_required',
  'illegal_transition',
  'stale_visit',
  'undo_not_allowed',
  'not_found',
  'no_contact',
  'suppressed',
  'not_relevant',
  'not_a_member',
  'invalid_input',
  'invalid_url',
  'invalid_resource',
  'range_too_large',
  'slot_unavailable',
  'slot_full',
  'too_late_to_change',
  'invalid_timezone',
  'slug_immutable',
  'not_authenticated',
  'permission_denied',
  'not_implemented',
  'party_size_out_of_range',
  'party_limit',
  'chat_disabled',
  'invalid_answers',
  'onsite_code_required',
  'onsite_code_invalid',
  'onsite_required',
  'captcha_failed',
  'snooze_limit_reached',
  'too_many_active_visits',
  'no_route',
  'already_in_queue',
  'invalid_arrive_after',
  'check_in_not_allowed',
  'invalid_times',
  'mfa_required',
  'contact_in_use',
  'query_too_short',
  'guest_blocked',
  'forbidden_role',
  'invalid_location',
  'last_owner',
  'operator_session_invalid',
  'invalid_trigger',
  'invalid_category',
  'unknown_variable',
  'hours_overlap',
  'hours_invalid',
  'hours_too_many',
  'illegal_payment_action',
  'display_names_locked',
  'invalid_scope',
  'unauthorized',
  'insufficient_scope',
  'event_full',
  'event_has_bookings',
  'event_booking_fixed',
  'offer_expired',
  'slot_taken',
  'attestation_required',
  'contact_suppressed',
  'consent_text_mismatch',
  'channel_prerequisite_missing',
  'invalid_report_definition',
  'analytics_disabled',
  'domain_taken',
  'plan_limit_reached',
  'slug_taken',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number] | 'unknown';

const KNOWN = new Set<string>(ERROR_CODES);

/** Shape of a PostgREST / supabase-js error. */
interface DbError {
  code?: unknown;
  message?: unknown;
}

/** Maps any error thrown by a Supabase call to an ErrorCode. Unrecognised errors are 'unknown'. */
export function errorCode(error: unknown): ErrorCode {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const { code, message } = error as DbError;
  if (typeof message === 'string' && KNOWN.has(message)) return message as ErrorCode;
  if (code === '42501') return 'permission_denied';
  return 'unknown';
}

/** True when the right response is to refetch and let the user try again. */
export function isRetryable(code: ErrorCode): boolean {
  return code === 'stale_visit' || code === 'rate_limited';
}

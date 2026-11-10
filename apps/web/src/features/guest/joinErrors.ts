import type { ErrorCode } from '@qm/domain';
import { RpcError } from './rpcError.ts';

const JOIN_ERRORS = [
  'queue_not_accepting',
  'capacity_reached',
  'rate_limited',
  'captcha_required',
  'captcha_failed',
  'onsite_code_required',
  'onsite_code_invalid',
  'onsite_required',
  'invalid_input',
  'invalid_answers',
  'too_many_active_visits',
  'no_route',
  'already_in_queue',
  'invalid_arrive_after',
  'not_found',
] as const;

/**
 * Why a queue takes no joins, as the database reports it (`not_accepting_reason`, plus
 * `online_full` for the hourly online ceiling). The join page has a sentence for each
 * (`join.notAccepting.*`).
 */
export type NotAcceptingReason =
  'org_suspended' | 'closed' | 'paused' | 'outside_hours' | 'full' | 'online_full';

const REFUSAL_REASONS: readonly string[] = [
  'org_suspended',
  'closed',
  'paused',
  'outside_hours',
  'full',
] satisfies NotAcceptingReason[];

/**
 * The reason behind a join the database refused because the queue stopped taking guests, so the
 * page can say what it says when it learns that by itself (#603): a guest who clicks just after
 * a pause hears "paused", not that the queue stopped for good. join_queue gives the reason as the
 * DETAIL of queue_not_accepting, and raises a suspended org as its own code. Null for any other
 * failure, or a reason the page has no sentence for.
 */
export function refusalReason(code: ErrorCode, error: unknown): NotAcceptingReason | null {
  if (code === 'org_suspended') return 'org_suspended';
  if (code !== 'queue_not_accepting' || !(error instanceof RpcError)) return null;
  const reason = error.details;
  return reason !== null && REFUSAL_REASONS.includes(reason)
    ? (reason as NotAcceptingReason)
    : null;
}

/**
 * join_queue's documented errors get their own copy; anything else is "try again". The queue's
 * hourly online ceiling (DETAIL queue_total) won't clear in a moment, so it sends guests to the desk;
 * nor will this phone's or this network's 10-minute limit (client, network: #474), so staff add
 * them. The two get their own copy: a single phone is not "this network".
 */
export function joinErrorKey(
  code: ErrorCode,
  error: unknown,
):
  | (typeof JOIN_ERRORS)[number]
  | 'rate_limited_total'
  | 'rate_limited_phone'
  | 'rate_limited_network'
  | 'unknown' {
  const detail = code === 'rate_limited' && error instanceof RpcError ? error.details : null;
  if (detail === 'queue_total') return 'rate_limited_total';
  if (detail === 'client') return 'rate_limited_phone';
  if (detail === 'network') return 'rate_limited_network';
  return (JOIN_ERRORS as readonly string[]).includes(code)
    ? (code as (typeof JOIN_ERRORS)[number])
    : 'unknown';
}

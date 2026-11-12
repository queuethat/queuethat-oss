import { errorCode } from '@qm/domain';

/**
 * The error a mutation throws when the database refuses with `plan_limit_reached` (a team or
 * location limit from the org's entitlements). `message` is the code, so screens that switch on
 * `error.message` still see it; `limit` is the number allowed when the database said so.
 * A deployment's `limits.reached` slot gets the same facts (src/extensions/types.ts).
 */
export class LimitReachedError extends Error {
  constructor(readonly limit?: number) {
    super('plan_limit_reached');
  }
}

/** A `LimitReachedError` for a PostgREST error with that code (`details` carries the limit), else null. */
export function asLimitReached(error: unknown): LimitReachedError | null {
  if (errorCode(error) !== 'plan_limit_reached') return null;
  const details = (error as { details?: unknown }).details;
  const limit = typeof details === 'string' ? Number(details) : NaN;
  return new LimitReachedError(Number.isInteger(limit) && limit >= 0 ? limit : undefined);
}

/** True for an error whose message is `plan_limit_reached`. */
export function isLimitReached(error: unknown): boolean {
  return error instanceof Error && error.message === 'plan_limit_reached';
}

/** The limit carried by the error, when there is one. */
export function limitOf(error: unknown): number | undefined {
  const limit = (error as { limit?: unknown } | null)?.limit;
  return typeof limit === 'number' ? limit : undefined;
}

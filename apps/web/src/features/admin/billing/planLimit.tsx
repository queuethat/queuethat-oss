import { errorCode } from '@qm/domain';
import { LinkButton } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';

/** What a plan caps: staff seats, or locations. */
export type PlanLimitKind = 'members' | 'locations';

/**
 * The error every mutation throws when the database refuses with `plan_limit_reached`. `message` is
 * the stable code, so screens that only switch on `error.message` still see it; `limit` is what the
 * plan includes when the database said so (the invite-staff function and `api.create_invitation`
 * do; the location trigger does not, and the notice then words it without a number).
 */
export class PlanLimitError extends Error {
  constructor(readonly limit?: number) {
    super('plan_limit_reached');
  }
}

/**
 * Turns a failed Supabase call into a `PlanLimitError`, or returns null when it is another error.
 * Pass the PostgREST error from an `rpc`/insert; `details` carries the limit when there is one.
 */
export function asPlanLimitError(error: unknown): PlanLimitError | null {
  if (errorCode(error) !== 'plan_limit_reached') return null;
  const details = (error as { details?: unknown }).details;
  const limit = typeof details === 'string' ? Number(details) : NaN;
  return new PlanLimitError(Number.isInteger(limit) && limit >= 0 ? limit : undefined);
}

/** True for a `PlanLimitError` (or any error whose message is the code). */
export function isPlanLimit(error: unknown): error is PlanLimitError {
  return error instanceof Error && error.message === 'plan_limit_reached';
}

/**
 * The one place a refused plan limit is explained: what the plan includes and how to get more.
 * Only owners can open Billing, so anyone else is told to ask one. Render it where the failed
 * action's error would go; the add-location screen reuses it with `kind="locations"`.
 */
export function PlanLimitNotice({
  kind,
  error,
  memberRole,
}: {
  kind: PlanLimitKind;
  error?: unknown;
  memberRole: string | undefined;
}) {
  const { t } = useTranslation('admin-billing');
  const limit = error instanceof PlanLimitError ? error.limit : undefined;
  return (
    <div role="alert" className="flex flex-col items-start gap-3" data-testid="plan-limit-notice">
      <p className="font-medium text-danger-strong">
        {limit === undefined
          ? t(`planLimit.${kind}Unknown`)
          : t(`planLimit.${kind}`, { count: limit })}
      </p>
      {memberRole === 'owner' ? (
        <LinkButton render={(p) => <Link to="/admin/billing" {...p} />}>
          {t('planLimit.upgrade')}
        </LinkButton>
      ) : (
        <p>{t('planLimit.askOwner')}</p>
      )}
    </div>
  );
}

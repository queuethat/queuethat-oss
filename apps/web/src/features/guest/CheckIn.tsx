import { BigButton } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { useGuestAct, type useVisitStatus } from './api.ts';

type Visit = NonNullable<ReturnType<typeof useVisitStatus>['data']>;

/**
 * "I'm here": a booked guest checks themselves in, offered only while the database lists `check_in`
 * in `guest_actions` (from the start of the check-in window, never before). The answer replaces the
 * live status, so the guest sees their place at once; whether they were late is the database's call.
 */
export function CheckIn({ token, visit }: { token: string; visit: Visit }) {
  const { t } = useTranslation('guest');
  const act = useGuestAct(token);
  if (!visit.guest_actions?.includes('check_in')) return null;
  return (
    <div className="flex w-full max-w-sm flex-col gap-2 self-center">
      <BigButton disabled={act.isPending} onClick={() => act.mutate('check_in')}>
        {t('status.checkIn.button')}
      </BigButton>
      {act.isError ? (
        <p role="alert" className="text-center font-medium text-danger-strong">
          {t('status.checkIn.failed')}
        </p>
      ) : null}
    </div>
  );
}

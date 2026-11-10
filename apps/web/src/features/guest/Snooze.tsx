import { errorCode } from '@qm/domain';
import { BigButton } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { useNow } from '../../lib/now.ts';
import { useGuestAct, type useVisitStatus } from './api.ts';

type Visit = NonNullable<ReturnType<typeof useVisitStatus>['data']>;

/**
 * "Please arrive by HH:MM" for a called guest, and a polite live warning once the database's
 * `warn_at` has passed (WCAG 2.2.1: a timed event is announced before it ends). Both moments come
 * from api.get_visit_status; the page only compares them with the clock.
 */
export function ArriveBy({ visit }: { visit: Visit }) {
  const { t, i18n } = useTranslation('guest-snooze');
  const now = useNow(5_000);
  if (visit.status !== 'called' || !visit.grace_until) return null;
  const deadline = Date.parse(visit.grace_until);
  const warn = visit.warn_at ? Date.parse(visit.warn_at) <= now : false;
  const minutes = Math.max(1, Math.ceil((deadline - now) / 60_000));
  return (
    <div className="flex flex-col gap-1 text-center">
      <p data-testid="arrive-by" className="text-lg font-semibold">
        {t('arriveBy', {
          time: new Date(deadline).toLocaleTimeString(i18n.language, {
            hour: '2-digit',
            minute: '2-digit',
          }),
        })}
      </p>
      {/* Always present so a screen reader tracks it; empty until it is time to warn. */}
      <p role="alert" aria-live="assertive" data-testid="arrive-warning" className="font-medium">
        {warn ? (deadline <= now ? t('warningNow') : t('warning', { count: minutes })) : null}
      </p>
    </div>
  );
}

/**
 * The guest's own two answers, offered only as the database offers them (`guest_actions`): "I'm on
 * my way" once called, "I need more time" while waiting or called, with how many are left.
 */
export function Snooze({ token, visit }: { token: string; visit: Visit }) {
  const { t } = useTranslation('guest-snooze');
  const act = useGuestAct(token);
  const actions = visit.guest_actions ?? [];
  const left = visit.snoozes_left ?? 0;
  const busy = act.isPending;
  const onMyWay = actions.includes('on_my_way') && visit.status === 'called';
  const needTime = actions.includes('need_more_time');
  if (!onMyWay && !needTime) return null;
  return (
    <div className="flex w-full max-w-sm flex-col gap-3 self-center">
      <ArriveBy visit={visit} />
      {onMyWay ? (
        <BigButton disabled={busy || !!visit.on_the_way} onClick={() => act.mutate('on_my_way')}>
          {visit.on_the_way ? t('onMyWayDone') : t('onMyWay')}
        </BigButton>
      ) : null}
      {needTime ? (
        <div className="flex flex-col gap-1 text-center">
          <BigButton
            variant="secondary"
            disabled={busy || left === 0}
            onClick={() => act.mutate('need_more_time')}
          >
            {t('needMoreTime')}
          </BigButton>
          <p className="text-sm" data-testid="snoozes-left">
            {left > 0
              ? `${t('needMoreTimeLeft', { count: left })}. ${t('needMoreTimeHint')}`
              : t('needMoreTimeNone')}
          </p>
        </div>
      ) : null}
      {act.isError ? (
        <p role="alert" className="text-center font-medium text-danger-strong">
          {errorCode(act.error) === 'snooze_limit_reached' ? t('limit') : t('failed')}
        </p>
      ) : null}
    </div>
  );
}

export default Snooze;

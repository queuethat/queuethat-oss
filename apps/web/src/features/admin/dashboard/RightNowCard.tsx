import { Card, LinkButton, Skeleton, TicketNumber } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import { useConsoleVisits, type ConsoleVisit } from '../../console/api.ts';

const NEXT_SHOWN = 3;

type LineVisit = Pick<ConsoleVisit, 'id' | 'ticket' | 'status' | 'name' | 'service' | 'joinedAt'>;

/** Who is in line, with a hand-off to the live queue. Display only: the console owns every action. */
export function RightNowCard({ visits, timeZone }: { visits: LineVisit[]; timeZone: string }) {
  const { t, i18n } = useTranslation('admin');
  const waiting = visits.filter((v) => v.status === 'waiting');
  const clock = new Intl.DateTimeFormat(i18n.language, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  return (
    <Card data-testid="right-now" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('today.rightNow.title')}</h2>
          <p className="text-muted" data-testid="right-now-count">
            {waiting.length
              ? t('today.rightNow.waiting', { count: waiting.length })
              : t('today.rightNow.nobody')}
          </p>
        </div>
        <LinkButton
          variant={waiting.length ? 'primary' : 'secondary'}
          render={(p) => <Link to="/staff" {...p} />}
        >
          {t('today.rightNow.open')}
        </LinkButton>
      </div>
      {waiting.length ? (
        <ol aria-label={t('today.rightNow.nextUp')} className="divide-y divide-border">
          {waiting.slice(0, NEXT_SHOWN).map((v) => (
            <li
              key={v.id}
              className="flex min-h-target flex-wrap items-center gap-x-3 gap-y-1 py-2"
            >
              <TicketNumber ticket={v.ticket} />
              <span className="min-w-24 flex-1 font-medium">
                {v.name ?? t('today.rightNow.walkIn')}
              </span>
              {v.service ? <span className="text-sm text-muted">{v.service}</span> : null}
              <span className="text-sm text-muted">
                {t('today.rightNow.joinedAt', { time: clock.format(new Date(v.joinedAt)) })}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {waiting.length > NEXT_SHOWN ? (
        <p className="text-sm text-muted">
          {t('today.rightNow.more', { count: waiting.length - NEXT_SHOWN })}
        </p>
      ) : null}
    </Card>
  );
}

/** The card for a location, kept live by the console's own query. */
export function RightNow({
  locationId,
  timeZone,
}: {
  locationId: string | undefined;
  timeZone: string;
}) {
  const { t } = useTranslation('admin');
  const visits = useConsoleVisits(locationId);
  if (visits.isError) return <p role="alert">{t('today.rightNow.error')}</p>;
  if (!visits.data) return <Skeleton label={t('today.rightNow.loading')} rows={2} />;
  return <RightNowCard visits={visits.data} timeZone={timeZone} />;
}

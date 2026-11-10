import { formatLocalTime } from '@qm/domain';
import { Badge, Button, Card, EmptyState } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import type { ConsoleVisit } from '../api.ts';
import { hourRange, localMinute, timelineEntries, type TimelineEntry } from './layout.ts';

const TONE = {
  expected: 'neutral',
  waiting: 'info',
  called: 'warning',
  serving: 'success',
  no_show: 'danger',
} as const;

/**
 * Today's expected arrivals and walk-ins on one vertical hours axis in the location's time zone,
 * with a line at the current time (S-14, #143). Appointments sit at their time, walk-ins at when
 * they joined. An expected guest who has arrived is checked in from here; the database says whether
 * the action is allowed (`actions`), and the list updates through the console's live query.
 */
export function Timeline({
  visits,
  timeZone,
  now,
  onCheckIn,
  busy,
}: {
  visits: ConsoleVisit[];
  timeZone: string;
  now: number;
  onCheckIn: (visit: ConsoleVisit) => void;
  busy?: string | null;
}) {
  const { t, i18n } = useTranslation('staff');
  const entries = timelineEntries(visits, timeZone, now);
  const nowMinute = localMinute(now, timeZone);
  const hours = hourRange(entries, nowMinute);
  const hourLabel = (h: number) =>
    new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', timeZone: 'UTC' }).format(
      Date.UTC(2000, 0, 1, h),
    );
  const nowLine = (
    <li key="now" data-testid="timeline-now" className="flex items-center gap-2 text-danger-strong">
      <span className="h-0.5 flex-1 bg-current" aria-hidden="true" />
      <span className="text-sm font-semibold">
        {t('console.timeline.now', {
          time: formatLocalTime(new Date(now), timeZone, i18n.language),
        })}
      </span>
    </li>
  );
  const card = (e: TimelineEntry) => {
    const v = e.visit;
    const late = v.status === 'expected' && !!v.scheduledAt && now > Date.parse(v.scheduledAt);
    return (
      <li key={v.id} data-testid="timeline-entry" data-status={v.status}>
        <Card
          className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${
            v.status === 'expected' ? 'border-dashed' : ''
          }`}
        >
          <span className="w-20 shrink-0 text-xl font-bold tabular-nums">{v.ticket}</span>
          <span className="min-w-0 flex-1 truncate">{v.name ?? t('console.noName')}</span>
          <span className="tabular-nums text-muted">
            {formatLocalTime(e.at, timeZone, i18n.language)}
          </span>
          <Badge tone={TONE[v.status]}>{t(`console.timeline.status.${v.status}`)}</Badge>
          {late ? <Badge tone="warning">{t('console.timeline.late')}</Badge> : null}
          {v.status === 'expected' && v.actions.includes('check_in') ? (
            <Button
              disabled={busy === v.id}
              aria-label={t('console.timeline.checkInFor', { ticket: v.ticket })}
              onClick={() => onCheckIn(v)}
            >
              {t('console.timeline.checkIn')}
            </Button>
          ) : null}
        </Card>
      </li>
    );
  };
  if (entries.length === 0) {
    return <EmptyState title={t('console.timeline.empty')} />;
  }
  return (
    <ol
      data-testid="timeline"
      className="flex flex-col gap-1"
      aria-label={t('console.timeline.label')}
    >
      {hours.map((h) => {
        const inHour = entries.filter((e) => Math.floor(e.minute / 60) === h);
        const before = inHour.filter((e) => e.minute <= nowMinute);
        const after = inHour.filter((e) => e.minute > nowMinute);
        const hasNow = Math.floor(nowMinute / 60) === h;
        return (
          <li key={h} className="grid grid-cols-[3.5rem_1fr] gap-3 border-t border-border py-2">
            <span className="text-sm font-semibold tabular-nums text-muted">{hourLabel(h)}</span>
            <ol className="flex min-h-8 flex-col gap-2">
              {before.map(card)}
              {hasNow ? nowLine : null}
              {after.map(card)}
            </ol>
          </li>
        );
      })}
    </ol>
  );
}

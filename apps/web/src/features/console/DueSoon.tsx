import { formatLocalTime } from '@qm/domain';
import { useTranslation } from '../../lib/translation.tsx';
import type { ConsoleVisit } from './api.ts';

/** How far ahead of its start an appointment counts as "due soon" for the console cue. */
export const DUE_SOON_MINUTES = 15;

/**
 * Appointments staff should keep an eye on: booked, not checked in, not yet late, and starting
 * within `leadMinutes` (or started a moment ago, inside the late tolerance). Soonest first.
 * Read-only: the ordering rule stays in the database, this only shows what it will do.
 */
export function dueSoon(
  visits: readonly ConsoleVisit[],
  now: number,
  leadMinutes = DUE_SOON_MINUTES,
): ConsoleVisit[] {
  return visits
    .filter(
      (v) =>
        v.status === 'expected' &&
        v.arriveAfter === null &&
        v.scheduledAt !== null &&
        // Past the late tolerance a check-in goes to the end of the line: nothing to hold a gap for.
        !(v.lateAfter && now > Date.parse(v.lateAfter)) &&
        Date.parse(v.scheduledAt) - now <= leadMinutes * 60_000,
    )
    .sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
}

/**
 * "Appointment due soon": tells staff a booked guest is about to arrive, so they can leave a
 * server free instead of starting a long walk-in. An on-time check-in goes ahead of walk-ins who
 * arrive after it (the database decides; nothing here reorders).
 */
export function DueSoon({
  visits,
  now,
  timeZone,
}: {
  visits: readonly ConsoleVisit[];
  now: number;
  timeZone: string;
}) {
  const { t, i18n } = useTranslation('staff');
  const due = dueSoon(visits, now);
  if (due.length === 0) return null;
  const when = (v: ConsoleVisit) => {
    const minutes = Math.round((Date.parse(v.scheduledAt!) - now) / 60_000);
    if (minutes > 0) return t('console.dueSoon.in', { count: minutes });
    if (minutes === 0) return t('console.dueSoon.now');
    return t('console.dueSoon.ago', { count: -minutes });
  };
  return (
    <aside
      aria-labelledby="due-soon-title"
      data-testid="due-soon"
      className="flex flex-col gap-1 rounded-card bg-warning-soft p-3 text-warning-strong"
    >
      <h2 id="due-soon-title" className="font-semibold">
        {t('console.dueSoon.title', { count: due.length })}
      </h2>
      <ul className="flex flex-col gap-0.5">
        {due.map((v) => (
          <li key={v.id} className="tabular-nums">
            {t('console.dueSoon.row', {
              who: [v.ticket, v.name].filter(Boolean).join(' '),
              time: formatLocalTime(new Date(v.scheduledAt!), timeZone, i18n.language),
              when: when(v),
            })}
          </li>
        ))}
      </ul>
      <p>{t('console.dueSoon.hint')}</p>
    </aside>
  );
}

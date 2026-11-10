import { Button, Card } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import type { ConsoleVisit } from '../api.ts';
import type { Overdue } from './threshold.ts';

/**
 * Amber rows for guests who have been with staff longer than expected (#144). "Complete" goes
 * through the console's usual action (with its undo toast); "Still serving" only hides the row
 * on this tablet for 15 minutes.
 */
export function ServingReminders({
  overdue,
  visits,
  onComplete,
  onSnooze,
  busy,
}: {
  overdue: Overdue[];
  visits: ConsoleVisit[];
  onComplete: (visit: ConsoleVisit) => void;
  onSnooze: (id: string) => void;
  busy?: string | null;
}) {
  const { t } = useTranslation('staff');
  const rows = overdue.flatMap((o) => {
    const visit = visits.find((v) => v.id === o.id);
    return visit ? [{ visit, minutes: o.minutes }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <section aria-label={t('console.servingReminder.region')} className="flex flex-col gap-2">
      {rows.map(({ visit, minutes }) => (
        <Card
          key={visit.id}
          data-testid="serving-reminder"
          className="flex flex-wrap items-center gap-3 bg-warning-soft text-warning-strong"
        >
          <span className="text-xl font-bold tabular-nums">{visit.ticket}</span>
          <p className="min-w-0 flex-1 font-semibold">
            {t('console.servingReminder.text', { count: minutes })}
          </p>
          <Button disabled={busy === visit.id} onClick={() => onComplete(visit)}>
            {t('console.servingReminder.complete', { ticket: visit.ticket })}
          </Button>
          <Button variant="secondary" onClick={() => onSnooze(visit.id)}>
            {t('console.servingReminder.still', { ticket: visit.ticket })}
          </Button>
        </Card>
      ))}
    </section>
  );
}

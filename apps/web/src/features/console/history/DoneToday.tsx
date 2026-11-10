import { formatLocalTime } from '@qm/domain';
import { Button, Card, TicketNumber } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import type { DoneVisit } from '../api.ts';
import { HistoryDrawer } from './HistoryDrawer.tsx';

/** Visits finished in the last hours, each with its history, so a dispute can be settled after the fact. */
export function DoneToday({ visits, timeZone }: { visits: DoneVisit[]; timeZone: string }) {
  const { t, i18n } = useTranslation('staff');
  const [open, setOpen] = useState<DoneVisit | null>(null);
  if (visits.length === 0) return null;
  return (
    <section aria-labelledby="section-done" data-testid="section-done" className="mt-4">
      <h2 id="section-done" className="mb-2 text-lg font-semibold">
        {t('console.history.done', { count: visits.length })}
      </h2>
      <ol className="flex flex-col gap-2">
        {visits.map((v) => (
          <li key={v.id} data-testid="done-visit">
            <Card className="flex flex-wrap items-center gap-4">
              <TicketNumber ticket={v.ticket} size="phone" className="w-24 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{v.name ?? t('console.noName')}</span>
              <span className="text-muted">
                {t(`console.history.status.${v.status}`, { defaultValue: v.status })} ·{' '}
                {formatLocalTime(v.finishedAt, timeZone, i18n.language)}
              </span>
              <Button
                variant="secondary"
                aria-label={t('console.history.openFor', { ticket: v.ticket })}
                onClick={() => setOpen(v)}
              >
                {t('console.history.open')}
              </Button>
            </Card>
          </li>
        ))}
      </ol>
      {open ? (
        <HistoryDrawer
          visitId={open.id}
          ticket={open.ticket}
          timeZone={timeZone}
          editable={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  );
}

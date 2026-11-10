import { Button, Card } from '@qm/ui';
import { useMemo, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { formatDay, formatTime, groupByDay, zoneName, type Slot } from './slots.ts';

/**
 * Day buttons, then time buttons for the picked day, all on the location's clock. Shared by the
 * booking page and the reschedule flow; which slots exist is the database's answer.
 */
export function SlotPicker({
  slots,
  tz,
  onPick,
}: {
  slots: Slot[];
  tz: string;
  onPick: (slotStart: string) => void;
}) {
  const { t, i18n } = useTranslation('booking');
  const days = useMemo(() => groupByDay(slots, tz), [slots, tz]);
  const [day, setDay] = useState<string | null>(null);
  const times = day ? (days.get(day) ?? []) : [];
  const first = slots[0]?.slot_start;

  return (
    <div className="flex flex-col gap-4">
      {first ? (
        <p className="text-sm text-muted">
          {t('book.timezone', { zone: zoneName(first, tz, i18n.language) })}
        </p>
      ) : null}
      {day === null ? (
        <section aria-labelledby="pick-day" className="flex flex-col gap-3">
          <h2 id="pick-day" className="text-lg font-semibold">
            {t('book.pickDay')}
          </h2>
          <ul className="grid grid-cols-2 gap-3">
            {[...days].map(([date, list]) => (
              <li key={date}>
                <Button
                  variant="secondary"
                  className="w-full"
                  aria-label={t('book.dayAria', {
                    day: formatDay(date, i18n.language),
                    count: list.length,
                  })}
                  onClick={() => setDay(date)}
                >
                  {formatDay(date, i18n.language)}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">
            {t('book.pickTime', { day: formatDay(day, i18n.language) })}
          </h2>
          <ul className="grid grid-cols-3 gap-3">
            {times.map((slot) => (
              <li key={slot.slot_start}>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => onPick(slot.slot_start)}
                >
                  {formatTime(slot.slot_start, tz, i18n.language)}
                </Button>
              </li>
            ))}
          </ul>
          <Button variant="secondary" onClick={() => setDay(null)}>
            {t('book.back')}
          </Button>
        </Card>
      )}
    </div>
  );
}

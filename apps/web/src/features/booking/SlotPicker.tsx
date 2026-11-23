import { Button, Card } from '@qm/ui';
import { useMemo, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import {
  formatDay,
  formatTime,
  groupByDay,
  localDate,
  weekStrips,
  zoneName,
  type Slot,
} from './slots.ts';

/**
 * A "Next free" shortcut, a week of days at a time (days with no free time are shown but
 * disabled, #84), then time buttons for the picked day, all on the location's clock. Shared by the
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
  const weeks = useMemo(() => weekStrips(days), [days]);
  const [week, setWeek] = useState(0);
  const [day, setDay] = useState<string | null>(null);
  const times = day ? (days.get(day) ?? []) : [];
  const first = [...days.values()][0]?.[0]?.slot_start;
  const shown = weeks[Math.min(week, weeks.length - 1)] ?? [];

  return (
    <div className="flex flex-col gap-4">
      {first ? (
        <p className="text-sm text-muted">
          {t('book.timezone', { zone: zoneName(first, tz, i18n.language) })}
        </p>
      ) : null}
      {day === null ? (
        <section aria-labelledby="pick-day" className="flex flex-col gap-3">
          {first ? (
            <Button className="w-full" onClick={() => onPick(first)} data-testid="next-free">
              {t('book.nextFree', {
                day: formatDay(localDate(first, tz), i18n.language),
                time: formatTime(first, tz, i18n.language),
              })}
            </Button>
          ) : null}
          <h2 id="pick-day" className="text-lg font-semibold">
            {t('book.pickDay')}
          </h2>
          <ul className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {shown.map((date) => {
              const count = days.get(date)?.length ?? 0;
              return (
                <li key={date}>
                  <Button
                    variant="secondary"
                    className="w-full px-1"
                    disabled={count === 0}
                    onClick={() => setDay(date)}
                  >
                    {/* The visible day starts the accessible name; the count follows for screen
                        readers only (WCAG 2.5.3). */}
                    <span className="flex flex-col leading-tight">
                      <span className="text-sm">{formatWeekday(date, i18n.language)}</span>
                      <span>{formatDayOfMonth(date, i18n.language)}</span>
                    </span>
                    <span className="sr-only">
                      {count === 0 ? t('book.dayNone') : t('book.dayTimes', { count })}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
          {weeks.length > 1 ? (
            <div className="flex justify-between gap-2">
              <Button
                variant="secondary"
                disabled={week === 0}
                onClick={() => setWeek((w) => w - 1)}
              >
                {t('book.prevWeek')}
              </Button>
              <Button
                variant="secondary"
                disabled={week >= weeks.length - 1}
                onClick={() => setWeek((w) => w + 1)}
              >
                {t('book.nextWeek')}
              </Button>
            </div>
          ) : null}
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

function formatWeekday(date: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, { timeZone: 'UTC', weekday: 'short' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

function formatDayOfMonth(date: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

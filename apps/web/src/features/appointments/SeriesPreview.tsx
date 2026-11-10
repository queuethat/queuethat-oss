import { useTranslation } from '../../lib/translation.tsx';
import { formatDay } from '../booking/slots.ts';
import type { SeriesResult } from './api.ts';

/** What a series would do, shown before the staff member confirms: dates that book and dates that conflict. */
export function SeriesPreview({ preview, time }: { preview: SeriesResult; time: string }) {
  const { t, i18n } = useTranslation('appointments');
  return (
    <div className="flex flex-col gap-4">
      <p className="font-semibold">{t('repeat.summary', { count: preview.booked.length, time })}</p>
      {preview.conflicts.length > 0 ? (
        <div role="alert" className="flex flex-col gap-2">
          <p className="font-medium text-danger-strong">
            {t('repeat.conflictsTitle', { count: preview.conflicts.length })}
          </p>
          <ul className="list-disc ps-6" aria-label={t('repeat.conflictsList')}>
            {preview.conflicts.map((c) => (
              <li key={c.date}>
                {formatDay(c.date, i18n.language)}
                {': '}
                {t(`repeat.code.${c.code}` as 'repeat.code.slot_full', {
                  defaultValue: t('repeat.code.slot_unavailable'),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.booked.length === 0 ? <p role="status">{t('repeat.nothing')}</p> : null}
    </div>
  );
}

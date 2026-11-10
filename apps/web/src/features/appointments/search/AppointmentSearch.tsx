import { Button, Card, Input, Select, Spinner } from '@qm/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { formatWhen, localDate } from '../../booking/slots.ts';
import { useAppointmentSearch, type SearchHit } from './api.ts';
import { presetRange, STATUS_FILTERS, validRange, type RangePreset } from './range.ts';

const DEBOUNCE_MS = 300;

/**
 * Finds appointments on any future date (A-15): type a name, the last digits of a phone, an email or a
 * booking reference. Picking a result hands it to the agenda, which opens that day with it highlighted.
 */
export function AppointmentSearch({
  locationId,
  tz,
  onPick,
}: {
  locationId: string;
  tz: string;
  onPick: (hit: SearchHit) => void;
}) {
  const { t, i18n } = useTranslation('appointments');
  const today = localDate(new Date(), tz);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [preset, setPreset] = useState<RangePreset>('90');
  const [custom, setCustom] = useState({ from: today, to: today });
  const [status, setStatus] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text]);
  const range = presetRange(preset, today, custom);
  const valid = validRange(range);
  const search = useAppointmentSearch(valid ? locationId : undefined, query, range, status);
  const hits = search.data ?? [];

  return (
    <section aria-label={t('search.section')} className="flex flex-col gap-3">
      <Input
        type="search"
        label={t('search.label')}
        hint={t('search.hint')}
        value={text}
        maxLength={80}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap gap-4">
        <Select
          label={t('search.range')}
          value={preset}
          onChange={(e) => setPreset(e.target.value as RangePreset)}
        >
          <option value="30">{t('search.next30')}</option>
          <option value="90">{t('search.next90')}</option>
          <option value="custom">{t('search.custom')}</option>
        </Select>
        {preset === 'custom' ? (
          <>
            <Input
              label={t('search.from')}
              type="date"
              value={custom.from}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })}
            />
            <Input
              label={t('search.to')}
              type="date"
              value={custom.to}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })}
            />
          </>
        ) : null}
        <Select
          label={t('search.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{t('search.anyStatus')}</option>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {t(`agenda.status.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      {!valid ? (
        <p role="alert">{t('search.badRange')}</p>
      ) : query.length < 2 ? null : search.isError ? (
        <p role="alert">{t('search.failed')}</p>
      ) : search.isPending ? (
        <Spinner label={t('search.loading')} />
      ) : hits.length === 0 ? (
        <p>{t('search.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('search.results')}>
          {hits.map((hit) => (
            <li key={hit.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-semibold">
                  {formatWhen(hit.starts_at, tz, i18n.language)}
                  {' · '}
                  {t('agenda.row', {
                    guest: hit.guest_name ?? '',
                    service: hit.service_name ?? '',
                  })}
                </p>
                <Button
                  variant="secondary"
                  aria-label={t('search.openFor', { guest: hit.guest_name ?? '' })}
                  onClick={() => onPick(hit)}
                >
                  {t('search.open')}
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

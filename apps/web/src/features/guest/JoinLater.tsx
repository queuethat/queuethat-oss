import { formatLocalTime } from '@qm/domain';
import { Select } from '@qm/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { laterSlots } from './joinLater.ts';

/** The short name of `tz` at `at` (CET, GMT+1…), so the time select says whose clock it shows. */
function zoneName(at: Date | undefined, tz: string): string {
  const part = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(at ?? new Date())
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? tz;
}

/**
 * Now or later today (J-13): quarter-hour arrival times within the queue's window, in the
 * location's time zone. Reports the chosen time (ISO), or null for "Now", through `onChange`.
 */
export default function JoinLater({
  maxHours,
  nowMs,
  timeZone,
  onChange,
}: {
  maxHours: number;
  nowMs: number;
  timeZone: string;
  onChange: (arriveAfter: string | null) => void;
}) {
  const { t, i18n } = useTranslation('guest');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const slots = laterSlots(new Date(nowMs), maxHours, timeZone);
  const slot = slots.find((s) => s.toISOString() === at) ?? slots[0];
  const chosen = when === 'later' && slot ? slot.toISOString() : null;
  useEffect(() => onChange(chosen), [chosen, onChange]);
  // Late in the day nothing fits: the guest can only join now.
  if (!nowMs || slots.length === 0) return null;
  return (
    <>
      <Select
        label={t('join.when.label')}
        value={when}
        onChange={(e) => setWhen(e.target.value as 'now' | 'later')}
      >
        <option value="now">{t('join.when.now')}</option>
        <option value="later">{t('join.when.later')}</option>
      </Select>
      {when === 'later' ? (
        <Select
          label={t('join.when.at')}
          hint={t('join.when.hint', { zone: zoneName(slot, timeZone) })}
          value={slot?.toISOString() ?? ''}
          onChange={(e) => setAt(e.target.value)}
        >
          {slots.map((s) => (
            <option key={s.toISOString()} value={s.toISOString()}>
              {formatLocalTime(s, timeZone, i18n.language)}
            </option>
          ))}
        </Select>
      ) : null}
    </>
  );
}

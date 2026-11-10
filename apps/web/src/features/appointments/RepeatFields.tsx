import { Input, Select } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';

export interface RepeatState {
  repeat: boolean;
  intervalWeeks: number;
  endsBy: 'count' | 'until';
  count: number;
  until: string;
}

export const NO_REPEAT: RepeatState = {
  repeat: false,
  intervalWeeks: 1,
  endsBy: 'count',
  count: 4,
  until: '',
};

/** True when the repeat settings can be sent: the database still owns the 26-occurrence cap. */
export function repeatReady(r: RepeatState): boolean {
  if (!r.repeat) return true;
  const ends = r.endsBy === 'count' ? r.count >= 2 : r.until !== '';
  return r.intervalWeeks >= 1 && r.intervalWeeks <= 8 && ends;
}

/** The "Repeat" control of the staff booking dialog: weekly or every N weeks, for a count or until a date. */
export function RepeatFields({
  value,
  onChange,
}: {
  value: RepeatState;
  onChange: (next: RepeatState) => void;
}) {
  const { t } = useTranslation('appointments');
  return (
    <div className="flex flex-col gap-4">
      <Select
        label={t('repeat.label')}
        value={value.repeat ? 'weekly' : 'none'}
        onChange={(e) => onChange({ ...value, repeat: e.target.value === 'weekly' })}
      >
        <option value="none">{t('repeat.none')}</option>
        <option value="weekly">{t('repeat.weekly')}</option>
      </Select>
      {value.repeat ? (
        <>
          <Input
            label={t('repeat.every')}
            type="number"
            inputMode="numeric"
            min={1}
            max={8}
            value={value.intervalWeeks}
            onChange={(e) => onChange({ ...value, intervalWeeks: Number(e.target.value) })}
          />
          <Select
            label={t('repeat.ends')}
            value={value.endsBy}
            onChange={(e) => onChange({ ...value, endsBy: e.target.value as 'count' | 'until' })}
          >
            <option value="count">{t('repeat.endsCount')}</option>
            <option value="until">{t('repeat.endsUntil')}</option>
          </Select>
          {value.endsBy === 'count' ? (
            <Input
              label={t('repeat.count')}
              type="number"
              inputMode="numeric"
              min={2}
              max={26}
              value={value.count}
              onChange={(e) => onChange({ ...value, count: Number(e.target.value) })}
            />
          ) : (
            <Input
              label={t('repeat.until')}
              type="date"
              value={value.until}
              onChange={(e) => onChange({ ...value, until: e.target.value })}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

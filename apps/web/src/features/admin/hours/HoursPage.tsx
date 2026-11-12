import { Badge, Button, Checkbox, ConfirmDestructive, Input, PageHeader, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { canEditLocation, locationSettingsQuery } from '../location/api.ts';
import {
  emptyWeek,
  hoursQuery,
  HoursSaveError,
  MAX_INTERVALS,
  useSaveHours,
  type Interval,
  type WeekHours,
} from './api.ts';
import { ExceptionsSection } from './exceptions/ExceptionsSection.tsx';
import { SendWindowSection } from './SendWindowSection.tsx';
import { crossesMidnight, intervalEnds, weekdayName } from './summary.ts';

/** Monday first; the database numbers Sunday 0. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DEFAULT_INTERVAL: Interval = { opens: '09:00', closes: '17:00' };
const KNOWN_ERRORS = ['hours_overlap', 'hours_invalid', 'hours_too_many', 'permission_denied'];

/** Weekly opening hours for the current location (ORG-5). Staff and managers see them read-only. */
export function HoursPage() {
  const { t } = useTranslation('admin-hours');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const hours = useQuery({ ...hoursQuery(location?.id ?? ''), enabled: !!location });
  const settings = useQuery({ ...locationSettingsQuery(location?.id ?? ''), enabled: !!location });
  if (!location || !org || !hours.data || !settings.data)
    return <Skeleton label={t('loading')} rows={2} />;
  const readOnly = !canEditLocation(org.role);
  return (
    <>
      <HoursForm
        key={location.id}
        locationId={location.id}
        orgId={org.id}
        tz={settings.data.settings.tz}
        saved={hours.data}
        readOnly={readOnly}
      />
      <ExceptionsSection
        key={`exceptions-${location.id}`}
        locationId={location.id}
        orgId={org.id}
        tz={settings.data.settings.tz}
        weekly={hours.data}
        readOnly={readOnly}
      />
      <SendWindowSection
        locationId={location.id}
        tz={settings.data.settings.tz}
        readOnly={readOnly}
      />
    </>
  );
}

function HoursForm({
  locationId,
  orgId,
  tz,
  saved,
  readOnly,
}: {
  locationId: string;
  orgId: string;
  tz: string;
  saved: WeekHours;
  readOnly: boolean;
}) {
  const { t, i18n } = useTranslation('admin-hours');
  const save = useSaveHours(locationId, orgId);
  const [week, setWeek] = useState<WeekHours>(saved);
  const locale = i18n.language;
  const change = (next: WeekHours) => {
    save.reset();
    setWeek(next);
  };
  const setDay = (weekday: number, intervals: Interval[]) =>
    change(week.map((day, d) => (d === weekday ? intervals : day)));

  const failure = save.error instanceof HoursSaveError ? save.error : null;
  const code = failure?.code ?? save.error?.message ?? '';
  const failedDay = failure?.weekday ?? null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!readOnly) save.mutate(week);
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-8">
      <PageHeader title={t('title')} description={t('intro', { tz })} />
      {readOnly ? <p className="text-muted">{t('readOnly')}</p> : null}
      {week.every((day) => day.length === 0) ? <p className="text-muted">{t('noHours')}</p> : null}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {save.error
          ? t(`errors.${KNOWN_ERRORS.includes(code) ? code : 'unknown'}` as 'errors.unknown', {
              day: failedDay === null ? '' : weekdayName(failedDay, locale),
            })
          : null}
      </p>
      <p role="status" className="font-medium empty:hidden">
        {save.isSuccess ? t('saved') : null}
      </p>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {readOnly ? null : (
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              onClick={() => {
                const monday = week[1] ?? [];
                change(week.map((day, d) => (d >= 2 && d <= 5 ? monday : day)));
              }}
            >
              {t('copyMonFri')}
            </Button>
          </div>
        )}
        {WEEK_ORDER.map((weekday) => (
          <DayRow
            key={weekday}
            weekday={weekday}
            intervals={week[weekday] ?? []}
            locale={locale}
            readOnly={readOnly}
            invalid={failedDay === weekday}
            onChange={(intervals) => setDay(weekday, intervals)}
            onCopyToAll={() => change(week.map(() => week[weekday] ?? []))}
          />
        ))}
        {readOnly ? null : (
          <div className="flex flex-wrap justify-between gap-3">
            <ConfirmDestructive
              triggerLabel={t('clear')}
              title={t('clearTitle')}
              description={t('clearDescription')}
              confirmLabel={t('clearConfirm')}
              cancelLabel={t('cancel')}
              triggerVariant="secondary"
              onConfirm={() => save.mutateAsync(emptyWeek()).then(() => setWeek(emptyWeek()))}
            />
            <Button type="submit" loading={save.isPending} loadingLabel={t('saving')}>
              {t('save')}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}

function DayRow({
  weekday,
  intervals,
  locale,
  readOnly,
  invalid,
  onChange,
  onCopyToAll,
}: {
  weekday: number;
  intervals: Interval[];
  locale: string;
  readOnly: boolean;
  invalid: boolean;
  onChange: (intervals: Interval[]) => void;
  onCopyToAll: () => void;
}) {
  const { t } = useTranslation('admin-hours');
  const day = weekdayName(weekday, locale);
  const patch = (index: number, change: Partial<Interval>) =>
    onChange(intervals.map((interval, i) => (i === index ? { ...interval, ...change } : interval)));
  return (
    <fieldset
      className={`flex flex-col gap-2 rounded-control border p-3 ${invalid ? 'border-danger' : 'border-border'}`}
      data-testid={`day-${weekday}`}
    >
      <legend className="px-1 text-lg font-semibold">{day}</legend>
      <Checkbox
        label={t('closed')}
        checked={intervals.length === 0}
        disabled={readOnly}
        onChange={(event) => onChange(event.target.checked ? [] : [DEFAULT_INTERVAL])}
      />
      {intervals.map((interval, index) => (
        <div key={index} className="flex flex-wrap items-end gap-3">
          <Input
            label={t('opens', { day, n: index + 1 })}
            type="time"
            required
            value={interval.opens}
            readOnly={readOnly}
            onChange={(event) => patch(index, { opens: event.target.value })}
          />
          <Input
            label={t('closes', { day, n: index + 1 })}
            type="time"
            required
            value={interval.closes}
            readOnly={readOnly}
            onChange={(event) => patch(index, { closes: event.target.value })}
          />
          {crossesMidnight(interval.opens, interval.closes) ? (
            <Badge tone="info">{t('nextDay')}</Badge>
          ) : null}
          {readOnly ? null : (
            <Button
              variant="secondary"
              aria-label={t('removeInterval', { day, n: index + 1 })}
              onClick={() => onChange(intervals.filter((_, i) => i !== index))}
            >
              {t('remove')}
            </Button>
          )}
          <p className="basis-full text-sm text-muted" data-testid="summary">
            {t('summary', intervalEnds(weekday, interval.opens, interval.closes, locale))}
          </p>
        </div>
      ))}
      {readOnly ? null : (
        <div className="flex flex-wrap gap-3">
          {intervals.length > 0 && intervals.length < MAX_INTERVALS ? (
            <Button
              variant="secondary"
              aria-label={t('addIntervalFor', { day })}
              onClick={() => onChange([...intervals, DEFAULT_INTERVAL])}
            >
              {t('addInterval')}
            </Button>
          ) : null}
          {intervals.length > 0 ? (
            <Button variant="secondary" onClick={onCopyToAll}>
              {t('copyToAll', { day })}
            </Button>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}

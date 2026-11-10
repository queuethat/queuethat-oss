import { Badge, Button, Card, Checkbox, ConfirmDestructive, Dialog, Input } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import type { WeekHours } from '../api.ts';
import {
  dateRange,
  intervalsText,
  MAX_RANGE_DAYS,
  shortDate,
  todayIn,
  weekdayOf,
  yearAfter,
} from './dates.ts';
import {
  exceptionsQuery,
  useAddException,
  useRemoveException,
  type HoursException,
} from './api.ts';

const KNOWN_ERRORS = ['hours_overlap', 'hours_invalid', 'permission_denied'];

/** Holidays and one-off changes to the weekly hours (ORG-6). Read-only for staff and managers. */
export function ExceptionsSection({
  locationId,
  orgId,
  tz,
  weekly,
  readOnly,
}: {
  locationId: string;
  orgId: string;
  tz: string;
  weekly: WeekHours;
  readOnly: boolean;
}) {
  const { t, i18n } = useTranslation('admin-hours');
  const locale = i18n.language;
  const query = useQuery(exceptionsQuery(locationId));
  const remove = useRemoveException(locationId);
  const [adding, setAdding] = useState(false);
  const today = todayIn(tz);
  const horizon = yearAfter(today);
  const all = query.data ?? [];
  const upcoming = all.filter((e) => e.date >= today && e.date <= horizon);
  const past = all.filter((e) => e.date < today);

  const preview = (e: HoursException) => {
    const usual = intervalsText(weekly[weekdayOf(e.date)] ?? []);
    const params = {
      date: shortDate(e.date, locale),
      hours: intervalsText(e.intervals),
      usual,
    };
    return e.closed
      ? t(usual ? 'exceptions.previewClosed' : 'exceptions.previewClosedAlready', params)
      : t(usual ? 'exceptions.previewHours' : 'exceptions.previewHoursNoUsual', params);
  };
  const row = (e: HoursException, canRemove: boolean) => (
    <li key={e.date} className="flex flex-wrap items-center gap-3" data-testid="exception">
      <div className="min-w-60 flex-1">
        <p>{preview(e)}</p>
        {e.note ? <p className="text-sm text-muted">{e.note}</p> : null}
      </div>
      <Badge tone={e.closed ? 'danger' : 'info'}>
        {e.closed ? t('exceptions.closedBadge') : t('exceptions.specialBadge')}
      </Badge>
      {canRemove ? (
        <ConfirmDestructive
          triggerLabel={t('exceptions.remove')}
          triggerAriaLabel={t('exceptions.removeDate', { date: shortDate(e.date, locale) })}
          triggerVariant="secondary"
          title={t('exceptions.removeTitle', { date: shortDate(e.date, locale) })}
          confirmLabel={t('exceptions.removeConfirm')}
          cancelLabel={t('cancel')}
          onConfirm={() => remove.mutateAsync(e.date)}
        />
      ) : null}
    </li>
  );

  return (
    <Card className="mx-auto mt-4 flex max-w-2xl flex-col gap-4">
      <h2 className="text-xl font-semibold">{t('exceptions.title')}</h2>
      <p className="text-muted">{t('exceptions.intro')}</p>
      {readOnly ? null : (
        <Button className="self-start" onClick={() => setAdding(true)}>
          {t('exceptions.add')}
        </Button>
      )}
      {upcoming.length === 0 ? (
        <p className="text-muted">{t('exceptions.none')}</p>
      ) : (
        <ul className="flex flex-col gap-3">{upcoming.map((e) => row(e, !readOnly))}</ul>
      )}
      {past.length > 0 ? (
        <details>
          <summary className="min-h-target cursor-pointer py-3 font-medium">
            {t('exceptions.past', { count: past.length })}
          </summary>
          <ul className="flex flex-col gap-3">{past.map((e) => row(e, false))}</ul>
        </details>
      ) : null}
      {adding ? (
        <AddDialog
          key="add"
          locationId={locationId}
          orgId={orgId}
          today={today}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </Card>
  );
}

function AddDialog({
  locationId,
  orgId,
  today,
  onClose,
}: {
  locationId: string;
  orgId: string;
  today: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin-hours');
  const add = useAddException(locationId, orgId);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [closed, setClosed] = useState(true);
  const [interval, setInterval] = useState({ opens: '09:00', closes: '13:00' });
  const [note, setNote] = useState('');
  const dates = dateRange(from, to || from);
  const tooLong = dates.length > MAX_RANGE_DAYS;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dates.length === 0 || tooLong) return;
    add.mutate({ dates, closed, interval, note }, { onSuccess: onClose });
  };
  const code = add.error?.message ?? '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('exceptions.addTitle')}
      description={t('exceptions.addDescription')}
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {add.error
            ? t(
                `exceptions.errors.${KNOWN_ERRORS.includes(code) ? code : 'unknown'}` as 'exceptions.errors.unknown',
              )
            : null}
        </p>
        <Input
          label={t('exceptions.from')}
          type="date"
          required
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          label={t('exceptions.to')}
          hint={t('exceptions.toHint')}
          type="date"
          value={to}
          min={from}
          error={dates.length === 0 || tooLong ? t('exceptions.rangeInvalid') : undefined}
          onChange={(e) => setTo(e.target.value)}
        />
        <Checkbox
          label={t('exceptions.closedAllDay')}
          checked={closed}
          onChange={(e) => setClosed(e.target.checked)}
        />
        {closed ? null : (
          <div className="flex flex-wrap gap-3">
            <Input
              label={t('exceptions.opens')}
              type="time"
              required
              value={interval.opens}
              onChange={(e) => setInterval({ ...interval, opens: e.target.value })}
            />
            <Input
              label={t('exceptions.closes')}
              type="time"
              required
              value={interval.closes}
              onChange={(e) => setInterval({ ...interval, closes: e.target.value })}
            />
          </div>
        )}
        <Input
          label={t('exceptions.note')}
          hint={t('exceptions.noteHint')}
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" loading={add.isPending} loadingLabel={t('saving')}>
            {t('exceptions.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

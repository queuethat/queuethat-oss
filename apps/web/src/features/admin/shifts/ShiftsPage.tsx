import { formatLocalTime, localTimeValue } from '@qm/domain';
import {
  Button,
  Card,
  ConfirmDestructive,
  Dialog,
  EmptyState,
  Input,
  ScrollRegion,
  Select,
  PageHeader,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { countersQuery } from '../../console/api.ts';
import { useSession } from '../../auth/api.ts';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { membersQuery } from '../team/api.ts';
import {
  addDays,
  shiftsQuery,
  useCopyWeek,
  useDeleteShift,
  useSaveShift,
  type Shift,
} from './api.ts';

const LONG_DAY: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
};

/** Monday of the week containing `day` (YYYY-MM-DD). */
function mondayOf(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}

function todayAt(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

/**
 * `/admin/shifts` (2B-ORG6, #270): the week's shifts as a people-by-days grid on wide screens and a
 * day-by-day list everywhere (also the screen-reader view). A shift across midnight is one block on
 * the service day it starts in; the database decides which day that is.
 */
export function ShiftsPage() {
  const { t, i18n } = useTranslation('shifts');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const [week, setWeek] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ shift?: Shift; day: string } | null>(null);
  const timeZone = location?.tz ?? 'UTC';
  const start = week ?? mondayOf(todayAt(timeZone));
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const shifts = useQuery({
    ...shiftsQuery(location?.id ?? '', days[0]!, days[6]!),
    enabled: !!location,
  });
  const members = useQuery({ ...membersQuery(org?.id ?? ''), enabled: !!org });
  const counters = useQuery({ ...countersQuery(location?.id ?? ''), enabled: !!location });
  const lastWeek = useQuery({
    ...shiftsQuery(location?.id ?? '', addDays(start, -7), addDays(start, -1)),
    enabled: !!location,
  });
  const copy = useCopyWeek(org?.id ?? '', location?.id ?? '', timeZone);
  if (!location || !org || shifts.isPending) return <Skeleton label={t('loading')} rows={2} />;
  if (shifts.isError) return <p role="alert">{t('error')}</p>;

  const nameOf = (id: string) =>
    members.data?.find((m) => m.userId === id)?.displayName || t('someone');
  const dayLabel = (day: string) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString(i18n.language, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  const times = (s: Shift) =>
    t('range', {
      from: formatLocalTime(s.startsAt, timeZone, i18n.language),
      to: formatLocalTime(s.endsAt, timeZone, i18n.language),
      next: localTimeValue(s.endsAt, timeZone) <= localTimeValue(s.startsAt, timeZone) ? '+1' : '',
    });
  const on = (day: string, userId?: string) =>
    (shifts.data ?? []).filter((s) => s.serviceDay === day && (!userId || s.userId === userId));
  const block = (s: Shift, withName: boolean) => (
    <Button
      key={s.id}
      variant="secondary"
      className="w-full justify-start text-left"
      onClick={() => setEditing({ shift: s, day: s.serviceDay })}
    >
      {withName ? `${nameOf(s.userId)} · ` : ''}
      {times(s)}
    </Button>
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 pb-8">
      <PageHeader title={t('title')} />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => setWeek(addDays(start, -7))}>
          {t('previous')}
        </Button>
        <p className="font-medium" data-testid="week-label">
          {t('week', { from: dayLabel(days[0]!), to: dayLabel(days[6]!) })}
        </p>
        <Button variant="secondary" onClick={() => setWeek(addDays(start, 7))}>
          {t('next')}
        </Button>
        <Button onClick={() => setEditing({ day: days[0]! })}>{t('add')}</Button>
        <Button
          variant="secondary"
          disabled={!lastWeek.data?.length || copy.isPending}
          onClick={() => copy.mutate(lastWeek.data ?? [])}
        >
          {t('copyLast')}
        </Button>
      </div>
      {copy.isError && <p role="alert">{t('copyFailed')}</p>}

      <ScrollRegion label={t('title')} className="hidden md:block">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{t('title')}</caption>
          <thead>
            <tr>
              <th scope="col" className="p-2">
                {t('person')}
              </th>
              {days.map((d) => (
                <th key={d} scope="col" className="p-2">
                  {dayLabel(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(members.data ?? []).map((m) => (
              <tr key={m.id} className="border-t border-border align-top">
                <th scope="row" className="p-2 font-medium">
                  {m.displayName || t('someone')}
                </th>
                {days.map((d) => (
                  <td key={d} className="flex flex-col gap-1 p-2" data-testid={`cell-${d}`}>
                    {on(d, m.userId ?? undefined).map((s) => block(s, false))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>

      <div className="flex flex-col gap-4 md:hidden" data-testid="shift-list">
        {days.map((d) => (
          <Card key={d} className="flex flex-col gap-2">
            <h2 className="font-semibold">{dayLabel(d)}</h2>
            {on(d).length === 0 ? (
              <p className="text-muted">{t('none')}</p>
            ) : (
              on(d).map((s) => block(s, true))
            )}
          </Card>
        ))}
      </div>
      {(shifts.data ?? []).length === 0 && <EmptyState title={t('empty')} />}

      {editing && (
        <ShiftDialog
          key={editing.shift?.id ?? 'new'}
          orgId={org.id}
          locationId={location.id}
          timeZone={timeZone}
          day={editing.day}
          shift={editing.shift}
          people={(members.data ?? []).flatMap((m) =>
            m.userId ? [{ id: m.userId, name: m.displayName || t('someone') }] : [],
          )}
          counters={counters.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ShiftDialog({
  orgId,
  locationId,
  timeZone,
  day,
  shift,
  people,
  counters,
  onClose,
}: {
  orgId: string;
  locationId: string;
  timeZone: string;
  day: string;
  shift?: Shift;
  people: { id: string; name: string }[];
  counters: { id: string; label: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation('shifts');
  const save = useSaveShift();
  const remove = useDeleteShift();
  const [userId, setUserId] = useState(shift?.userId ?? people[0]?.id ?? '');
  const [date, setDate] = useState(day);
  const [start, setStart] = useState(shift ? localTimeValue(shift.startsAt, timeZone) : '09:00');
  const [end, setEnd] = useState(shift ? localTimeValue(shift.endsAt, timeZone) : '17:00');
  const [counterId, setCounterId] = useState(shift?.counterId ?? '');
  const [note, setNote] = useState(shift?.note ?? '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      {
        id: shift?.id,
        orgId,
        locationId,
        userId,
        counterId: counterId || null,
        day: date,
        start,
        end,
        timeZone,
        note,
      },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog open onClose={onClose} title={shift ? t('edit') : t('add')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Select label={t('person')} value={userId} onChange={(e) => setUserId(e.target.value)}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Input
          label={t('date')}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
        <div className="grid grid-cols-2 gap-4">
          <Input
            label={t('start')}
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
          />
          <Input
            label={t('end')}
            hint={t('endHint')}
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            required
          />
        </div>
        <Select
          label={t('counter')}
          value={counterId}
          onChange={(e) => setCounterId(e.target.value)}
        >
          <option value="">{t('anyCounter')}</option>
          {counters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        <Input
          label={t('note')}
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {save.isError ? t('saveFailed') : null}
        </p>
        <div className="flex flex-wrap justify-between gap-3">
          {shift ? (
            <ConfirmDestructive
              triggerLabel={t('delete')}
              triggerVariant="secondary"
              title={t('deleteTitle')}
              confirmLabel={t('delete')}
              cancelLabel={t('keep')}
              onConfirm={() => remove.mutateAsync(shift.id).then(onClose, () => undefined)}
            />
          ) : (
            <span />
          )}
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" loading={save.isPending} loadingLabel={t('saving')}>
              {t('save')}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

/** `/staff/shifts`: the caller's own upcoming shifts, read only. */
export function MyShiftsPage() {
  const { t, i18n } = useTranslation('shifts');
  const { location } = useCurrentLocation();
  const userId = useSession().data?.user.id;
  const timeZone = location?.tz ?? 'UTC';
  const today = todayAt(timeZone);
  const shifts = useQuery({
    ...shiftsQuery(location?.id ?? '', today, addDays(today, 28)),
    enabled: !!location,
  });
  if (!location || shifts.isPending) return <Skeleton label={t('loading')} rows={2} />;
  const mine = (shifts.data ?? []).filter((s) => s.userId === userId);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-8">
      <PageHeader title={t('mine')} />
      {mine.length === 0 ? (
        <EmptyState title={t('noneMine')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {mine.map((s) => (
            <li key={s.id}>
              <Card>
                <p className="font-semibold">
                  {new Date(`${s.serviceDay}T12:00:00Z`).toLocaleDateString(
                    i18n.language,
                    LONG_DAY,
                  )}
                </p>
                <p>
                  {t('range', {
                    from: formatLocalTime(s.startsAt, timeZone, i18n.language),
                    to: formatLocalTime(s.endsAt, timeZone, i18n.language),
                    next:
                      localTimeValue(s.endsAt, timeZone) <= localTimeValue(s.startsAt, timeZone)
                        ? '+1'
                        : '',
                  })}
                </p>
                {s.note && <p className="text-muted">{s.note}</p>}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

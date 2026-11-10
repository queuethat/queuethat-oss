import {
  Button,
  Card,
  Checkbox,
  ConfirmDestructive,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { zoneName } from '../../booking/slots.ts';
import { canManageQueues } from '../queues/api.ts';
import { membersQuery } from '../team/api.ts';
import {
  exceptionsQuery,
  rulesQuery,
  useChangeAvailability,
  type Exception,
  type Rule,
} from './api.ts';
import { overlapsAny } from './overlap.ts';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday first; 0 is Sunday in the database

/** `/admin/availability` (A-4): weekly hours and exceptions for a staff member or the whole location. */
export function AvailabilityPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const [staff, setStaff] = useState<string | null>(null);
  const members = useQuery({ ...membersQuery(location?.org_id ?? ''), enabled: !!location });
  const rules = useQuery({ ...rulesQuery(location?.id ?? '', staff), enabled: !!location });
  const exceptions = useQuery({
    ...exceptionsQuery(location?.id ?? '', staff),
    enabled: !!location,
  });
  if (!location || !rules.data || !exceptions.data)
    return <Skeleton label={t('availability.loading')} rows={2} />;
  const canManage = canManageQueues(org?.role);
  const people = (members.data ?? []).filter((m) => m.userId);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 pb-8">
      <PageHeader title={t('availability.title')} />
      <Select
        label={t('availability.staff')}
        value={staff ?? ''}
        onChange={(e) => setStaff(e.target.value || null)}
      >
        <option value="">{t('availability.anyStaff')}</option>
        {people.map((m) => (
          <option key={m.id} value={m.userId!}>
            {m.displayName ?? m.email ?? m.userId}
          </option>
        ))}
      </Select>
      <Zone tz={location.tz} />
      {canManage ? null : <p className="text-muted">{t('availability.readOnly')}</p>}
      <Editor
        key={staff ?? 'any'}
        target={{ orgId: location.org_id, locationId: location.id, staff }}
        rules={rules.data}
        exceptions={exceptions.data}
        canManage={canManage}
      />
    </div>
  );
}

function Zone({ tz }: { tz: string }) {
  const { t, i18n } = useTranslation('admin');
  return (
    <p className="text-sm text-muted">
      {t('availability.timezone', {
        zone: zoneName(new Date().toISOString(), tz, i18n.language),
        tz,
      })}
    </p>
  );
}

function Editor({
  target,
  rules,
  exceptions,
  canManage,
}: {
  target: { orgId: string; locationId: string; staff: string | null };
  rules: Rule[];
  exceptions: Exception[];
  canManage: boolean;
}) {
  const { t, i18n } = useTranslation('admin');
  const change = useChangeAvailability(target);
  const dayName = (d: number) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 0, 4 + d)),
    );
  const [weekday, setWeekday] = useState(1);
  const [starts, setStarts] = useState('09:00');
  const [ends, setEnds] = useState('17:00');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [overlap, setOverlap] = useState(false);
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<'unavailable' | 'extra'>('unavailable');
  const [whole, setWhole] = useState(true);
  const [xStarts, setXStarts] = useState('');
  const [xEnds, setXEnds] = useState('');
  const [note, setNote] = useState('');
  const [needsTimes, setNeedsTimes] = useState(false);
  const failure = change.error
    ? change.error.message === 'permission_denied'
      ? 'permission_denied'
      : 'unknown'
    : null;

  function addRange(event: FormEvent) {
    event.preventDefault();
    const range = { starts, ends, validFrom: validFrom || null, validTo: validTo || null };
    const same = rules.filter((r) => r.weekday === weekday);
    if (overlapsAny(range, same)) return setOverlap(true);
    setOverlap(false);
    change.mutate({ table: 'rule', kind: 'add', weekday, range });
  }

  function addException(event: FormEvent) {
    event.preventDefault();
    if (!date) return;
    const timed = !whole && xStarts && xEnds;
    if (kind === 'extra' && !timed) return setNeedsTimes(true);
    setNeedsTimes(false);
    change.mutate({
      table: 'exception',
      kind: 'add',
      value: {
        localDate: date,
        kind,
        starts: timed ? xStarts : null,
        ends: timed ? xEnds : null,
        note: note.trim() || null,
      },
    });
  }

  function Remove({ table, id, what }: { table: 'rule' | 'exception'; id: string; what: string }) {
    return canManage ? (
      <ConfirmDestructive
        triggerLabel={t('availability.remove')}
        triggerAriaLabel={t('availability.removeAria', { what })}
        triggerVariant="secondary"
        title={t('availability.removeTitle')}
        description={t('availability.removeBody')}
        confirmLabel={t('availability.removeConfirm')}
        cancelLabel={t('availability.removeKeep')}
        onConfirm={() => change.mutateAsync({ table, kind: 'remove', id })}
      />
    ) : null;
  }

  const rangeText = (r: Rule) =>
    `${r.starts}–${r.ends}${r.ends <= r.starts ? ` (${t('availability.overnight')})` : ''}${
      r.validFrom || r.validTo
        ? ` · ${t('availability.validRange', { from: r.validFrom ?? '…', to: r.validTo ?? '…' })}`
        : ''
    }`;

  return (
    <>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(`availability.errors.${failure}`) : null}
      </p>
      <section aria-labelledby="weekly-title" className="flex flex-col gap-3">
        <h2 id="weekly-title" className="text-lg font-semibold">
          {t('availability.weekly')}
        </h2>
        {rules.length === 0 ? <p>{t('availability.noRanges')}</p> : null}
        <ul className="flex flex-col gap-2">
          {WEEKDAYS.flatMap((d) =>
            rules
              .filter((r) => r.weekday === d)
              .map((r) => (
                <li key={r.id}>
                  <Card className="flex items-center justify-between gap-3" data-testid="range">
                    <span>
                      <strong>{dayName(d)}</strong> {rangeText(r)}
                    </span>
                    <Remove table="rule" id={r.id} what={`${dayName(d)} ${r.starts}–${r.ends}`} />
                  </Card>
                </li>
              )),
          )}
        </ul>
        {canManage ? (
          <form className="flex flex-col gap-3" onSubmit={addRange}>
            <Select
              label={t('availability.day')}
              value={String(weekday)}
              onChange={(e) => setWeekday(Number(e.target.value))}
            >
              {WEEKDAYS.map((d) => (
                <option key={d} value={d}>
                  {dayName(d)}
                </option>
              ))}
            </Select>
            <Input
              label={t('availability.from')}
              type="time"
              required
              value={starts}
              onChange={(e) => setStarts(e.target.value)}
            />
            <Input
              label={t('availability.to')}
              type="time"
              required
              value={ends}
              onChange={(e) => setEnds(e.target.value)}
            />
            <Input
              label={t('availability.validFrom')}
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
            <Input
              label={t('availability.validTo')}
              type="date"
              value={validTo}
              onChange={(e) => setValidTo(e.target.value)}
            />
            <p role="alert" className="font-medium text-danger-strong empty:hidden">
              {overlap ? t('availability.overlap') : null}
            </p>
            <Button
              type="submit"
              loading={change.isPending}
              loadingLabel={t('availability.addRange')}
            >
              {t('availability.addRange')}
            </Button>
          </form>
        ) : null}
      </section>

      <section aria-labelledby="exceptions-title" className="flex flex-col gap-3">
        <h2 id="exceptions-title" className="text-lg font-semibold">
          {t('availability.exceptions')}
        </h2>
        {exceptions.length === 0 ? <p>{t('availability.noExceptions')}</p> : null}
        <ul className="flex flex-col gap-2">
          {exceptions.map((x) => {
            const line = t('availability.exceptionLine', {
              date: x.localDate,
              kind: t(`availability.${x.kind}`),
              when: x.starts ? `${x.starts}–${x.ends}` : t('availability.allDay'),
            });
            return (
              <li key={x.id}>
                <Card className="flex items-center justify-between gap-3" data-testid="exception">
                  <span>
                    {line}
                    {x.note ? ` · ${x.note}` : ''}
                  </span>
                  <Remove table="exception" id={x.id} what={line} />
                </Card>
              </li>
            );
          })}
        </ul>
        {canManage ? (
          <form className="flex flex-col gap-3" onSubmit={addException}>
            <Input
              label={t('availability.date')}
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <Select
              label={t('availability.kind')}
              value={kind}
              onChange={(e) => setKind(e.target.value as 'unavailable' | 'extra')}
            >
              <option value="unavailable">{t('availability.unavailable')}</option>
              <option value="extra">{t('availability.extra')}</option>
            </Select>
            <Checkbox
              label={t('availability.wholeDay')}
              checked={whole}
              onChange={(e) => setWhole(e.target.checked)}
            />
            {whole ? null : (
              <>
                <Input
                  label={t('availability.from')}
                  type="time"
                  value={xStarts}
                  onChange={(e) => setXStarts(e.target.value)}
                />
                <Input
                  label={t('availability.to')}
                  type="time"
                  value={xEnds}
                  onChange={(e) => setXEnds(e.target.value)}
                />
              </>
            )}
            <Input
              label={t('availability.note')}
              maxLength={200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p role="alert" className="font-medium text-danger-strong empty:hidden">
              {needsTimes ? t('availability.exceptionNeedsTimes') : null}
            </p>
            <Button
              type="submit"
              loading={change.isPending}
              loadingLabel={t('availability.addException')}
            >
              {t('availability.addException')}
            </Button>
          </form>
        ) : null}
      </section>
    </>
  );
}

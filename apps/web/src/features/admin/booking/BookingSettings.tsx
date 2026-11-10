import { Button, Card, Checkbox, ConfirmDestructive, Input, Select, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useServiceSlots } from '../../booking/api.ts';
import { addDays, formatDay, formatTime, groupByDay, localDate } from '../../booking/slots.ts';
import {
  capacityRulesQuery,
  policyQuery,
  useChangeCapacity,
  useSavePolicy,
  type CapacityRule,
  type PolicySettings,
} from './api.ts';
import { validatePolicy } from './validate.ts';

interface Props {
  service: { id: string; name: string };
  org: { orgId: string; locationId: string; slug: string; tz: string };
  canManage: boolean;
  onClose: () => void;
}

/** The Booking panel of a service: bookability and slot rules, capacity rules and a 7-day preview (A-2, A-3, A-5). */
export function BookingSettings({ service, org, canManage, onClose }: Props) {
  const { t } = useTranslation('admin');
  const policy = useQuery(policyQuery(service.id));
  const rules = useQuery(capacityRulesQuery(service.id));
  if (!policy.data || !rules.data) return <Spinner label={t('services.loading')} />;
  const target = { orgId: org.orgId, locationId: org.locationId, serviceId: service.id };
  return (
    <Card className="flex flex-col gap-6" data-testid="booking-settings">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('booking.title', { service: service.name })}</h2>
        <Button variant="secondary" onClick={onClose}>
          {t('booking.close')}
        </Button>
      </div>
      {canManage ? null : <p className="text-muted">{t('booking.readOnly')}</p>}
      <PolicyForm initial={policy.data} target={target} canManage={canManage} />
      <CapacityEditor rules={rules.data} target={target} canManage={canManage} />
      <Preview serviceId={service.id} slug={org.slug} tz={org.tz} />
    </Card>
  );
}

type Target = { orgId: string; locationId: string; serviceId: string };

function PolicyForm({
  initial,
  target,
  canManage,
}: {
  initial: PolicySettings;
  target: Target;
  canManage: boolean;
}) {
  const { t } = useTranslation('admin');
  const save = useSavePolicy(target);
  const [s, setS] = useState(initial);
  const [shown, setShown] = useState(false);
  const errors = validatePolicy(s);
  const num = (key: Exclude<keyof PolicySettings, 'bookable' | 'durationMinutes'>) => ({
    type: 'number' as const,
    inputMode: 'numeric' as const,
    readOnly: !canManage,
    value: String(s[key]),
    error:
      shown && errors[key]
        ? t(`booking.invalid.${errors[key]}` as 'booking.invalid.buffer')
        : undefined,
    onChange: (e: { target: { value: string } }) =>
      setS((v) => ({ ...v, [key]: Number(e.target.value) })),
  });
  const f = {
    slotMinutes: num('slotMinutes'),
    slotOffsetMinutes: num('slotOffsetMinutes'),
    bufferBeforeMinutes: num('bufferBeforeMinutes'),
    bufferAfterMinutes: num('bufferAfterMinutes'),
    minNoticeMinutes: num('minNoticeMinutes'),
    maxDaysAhead: num('maxDaysAhead'),
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    setShown(true);
    if (Object.keys(errors).length === 0) save.mutate(s);
  }
  const failure = save.error
    ? save.error.message === 'permission_denied'
      ? 'permission_denied'
      : 'unknown'
    : null;
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <Checkbox
        label={t('booking.bookable')}
        hint={t('booking.bookableHint')}
        checked={s.bookable}
        disabled={!canManage}
        onChange={(e) => setS((v) => ({ ...v, bookable: e.target.checked }))}
      />
      <Input
        label={t('booking.slotMinutes')}
        hint={t('booking.slotMinutesHint')}
        min={5}
        {...f.slotMinutes}
      />
      <Input label={t('booking.slotOffsetMinutes')} min={0} {...f.slotOffsetMinutes} />
      <Input
        label={t('booking.durationMinutes')}
        hint={t('booking.durationHint')}
        type="number"
        inputMode="numeric"
        readOnly={!canManage}
        value={s.durationMinutes === null ? '' : String(s.durationMinutes)}
        error={shown && errors.durationMinutes ? t('booking.invalid.durationMinutes') : undefined}
        onChange={(e) =>
          setS((v) => ({
            ...v,
            durationMinutes: e.target.value === '' ? null : Number(e.target.value),
          }))
        }
      />
      <Input label={t('booking.bufferBeforeMinutes')} min={0} {...f.bufferBeforeMinutes} />
      <Input label={t('booking.bufferAfterMinutes')} min={0} {...f.bufferAfterMinutes} />
      <Input label={t('booking.minNoticeMinutes')} min={0} {...f.minNoticeMinutes} />
      <Input label={t('booking.maxDaysAhead')} min={1} max={365} {...f.maxDaysAhead} />
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(`booking.errors.${failure}`) : null}
      </p>
      <p role="status" className="empty:hidden">
        {save.isSuccess ? t('booking.saved') : null}
      </p>
      {canManage ? (
        <Button type="submit" loading={save.isPending} loadingLabel={t('booking.saving')}>
          {t('booking.save')}
        </Button>
      ) : null}
    </form>
  );
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

function CapacityEditor({
  rules,
  target,
  canManage,
}: {
  rules: CapacityRule[];
  target: Target;
  canManage: boolean;
}) {
  const { t, i18n } = useTranslation('admin');
  const change = useChangeCapacity(target);
  const [scope, setScope] = useState<'slot' | 'day'>('slot');
  const [applies, setApplies] = useState<'default' | 'weekday' | 'date'>('default');
  const [weekday, setWeekday] = useState(1);
  const [date, setDate] = useState('');
  const [capacity, setCapacity] = useState(1);
  const dayName = (d: number) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 0, 4 + d)),
    );
  const describe = (r: Omit<CapacityRule, 'id'>) =>
    t('booking.capacity.rule', {
      scope: t(`booking.capacity.scope_${r.scope}`),
      applies:
        r.localDate !== null
          ? r.localDate
          : r.weekday !== null
            ? t('booking.capacity.weekday', { day: dayName(r.weekday) })
            : t('booking.capacity.default'),
      count: r.capacity,
    });
  function add(event: FormEvent) {
    event.preventDefault();
    if (applies === 'date' && !date) return;
    change.mutate({
      kind: 'add',
      rule: {
        scope,
        weekday: applies === 'weekday' ? weekday : null,
        localDate: applies === 'date' ? date : null,
        capacity: Math.max(0, Math.floor(capacity)),
      },
    });
  }
  return (
    <section className="flex flex-col gap-3" aria-labelledby="capacity-title">
      <h3 id="capacity-title" className="text-lg font-semibold">
        {t('booking.capacity.title')}
      </h3>
      <p className="text-sm text-muted">{t('booking.capacity.hint')}</p>
      {rules.length === 0 ? <p>{t('booking.capacity.empty')}</p> : null}
      <ul className="flex flex-col gap-2">
        {rules.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3">
            <span>{describe(r)}</span>
            {canManage ? (
              <ConfirmDestructive
                triggerLabel={t('booking.capacity.remove')}
                triggerAriaLabel={t('booking.capacity.removeAria', { rule: describe(r) })}
                triggerVariant="secondary"
                title={t('booking.capacity.removeTitle')}
                description={t('booking.capacity.removeBody')}
                confirmLabel={t('booking.capacity.removeConfirm')}
                cancelLabel={t('booking.capacity.removeKeep')}
                onConfirm={() => change.mutateAsync({ kind: 'remove', id: r.id })}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <form className="flex flex-col gap-3" onSubmit={add}>
          <Select
            label={t('booking.capacity.scope')}
            value={scope}
            onChange={(e) => setScope(e.target.value as 'slot' | 'day')}
          >
            <option value="slot">{t('booking.capacity.scope_slot')}</option>
            <option value="day">{t('booking.capacity.scope_day')}</option>
          </Select>
          <Select
            label={t('booking.capacity.applies')}
            value={applies}
            onChange={(e) => setApplies(e.target.value as 'default' | 'weekday' | 'date')}
          >
            <option value="default">{t('booking.capacity.default')}</option>
            <option value="weekday">{t('booking.capacity.weekdayLabel')}</option>
            <option value="date">{t('booking.capacity.date')}</option>
          </Select>
          {applies === 'weekday' ? (
            <Select
              label={t('booking.capacity.weekdayLabel')}
              value={String(weekday)}
              onChange={(e) => setWeekday(Number(e.target.value))}
            >
              {WEEKDAYS.map((d) => (
                <option key={d} value={d}>
                  {dayName(d)}
                </option>
              ))}
            </Select>
          ) : null}
          {applies === 'date' ? (
            <Input
              label={t('booking.capacity.dateLabel')}
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          ) : null}
          <Input
            label={t('booking.capacity.value')}
            type="number"
            inputMode="numeric"
            min={0}
            value={String(capacity)}
            onChange={(e) => setCapacity(Number(e.target.value))}
          />
          <p role="alert" className="font-medium text-danger-strong empty:hidden">
            {change.error
              ? change.error.message === 'duplicate'
                ? t('booking.capacity.duplicate')
                : t('booking.errors.unknown')
              : null}
          </p>
          <Button
            type="submit"
            variant="secondary"
            loading={change.isPending}
            loadingLabel={t('booking.saving')}
          >
            {t('booking.capacity.add')}
          </Button>
        </form>
      ) : null}
    </section>
  );
}

/** The next 7 local days as guests would be offered them right now, from the public slot listing. */
function Preview({ serviceId, slug, tz }: { serviceId: string; slug: string; tz: string }) {
  const { t, i18n } = useTranslation('admin');
  const availability = useServiceSlots(slug, [serviceId], tz);
  if (availability.isPending) return <Spinner label={t('booking.preview.loading')} />;
  const today = localDate(new Date(), tz);
  const byDay = groupByDay(availability.slots[serviceId] ?? [], tz);
  return (
    <section
      aria-labelledby="preview-title"
      className="flex flex-col gap-2"
      data-testid="booking-preview"
    >
      <h3 id="preview-title" className="text-lg font-semibold">
        {t('booking.preview.title')}
      </h3>
      <p className="text-sm text-muted">{t('booking.preview.hint')}</p>
      <ul className="flex flex-col gap-1">
        {Array.from({ length: 7 }, (_, i) => addDays(today, i)).map((day) => (
          <li key={day} data-day={day}>
            <strong>{formatDay(day, i18n.language)}</strong>
            {': '}
            {byDay.get(day)
              ? byDay
                  .get(day)!
                  .map((s) => formatTime(s.slot_start, tz, i18n.language))
                  .join(', ')
              : t('booking.preview.none')}
          </li>
        ))}
      </ul>
    </section>
  );
}

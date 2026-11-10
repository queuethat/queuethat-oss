import {
  Badge,
  Button,
  Checkbox,
  ConfirmDestructive,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { membersQuery } from '../team/api.ts';
import {
  canManageReports,
  reportSchedulesQuery,
  useDeleteSchedule,
  useSaveSchedule,
  useSendPreview,
  useSetScheduleEnabled,
  type ReportSchedule,
} from './api.ts';

const ERRORS = ['invalid_recipient', 'not_found', 'permission_denied', 'rate_limited'];
const errorKey = (message: string | undefined) =>
  `errors.${message && ERRORS.includes(message) ? message : 'unknown'}` as 'errors.unknown';
const hhmm = (time: string) => time.slice(0, 5);

/** `/admin/reports/schedules` (3-RPT2, #369): create, edit, pause and preview scheduled email reports. */
export function ReportSchedulesPage() {
  const { t } = useTranslation('admin-reports');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('title')} />
      {canManageReports(org.role) ? (
        <ScheduleList orgId={org.id} />
      ) : (
        <p className="text-muted">{t('adminsOnly')}</p>
      )}
    </div>
  );
}

function ScheduleList({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation('admin-reports');
  const toast = useToast();
  const query = useQuery(reportSchedulesQuery(orgId));
  const setEnabled = useSetScheduleEnabled(orgId);
  const remove = useDeleteSchedule(orgId);
  const preview = useSendPreview();
  const [editing, setEditing] = useState<ReportSchedule | 'new' | null>(null);

  if (query.isError) return <p role="alert">{t('errors.unknown')}</p>;
  if (!query.data) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <section className="flex flex-col gap-4" aria-label={t('title')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-muted">{t('intro')}</p>
        <Button onClick={() => setEditing('new')}>{t('add')}</Button>
      </div>
      {query.data.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {query.data.map((s) => {
            const frequency = t(`frequency.${s.frequency}` as 'frequency.daily');
            return (
              <li key={s.id} className="flex flex-col gap-3 py-4" data-testid="schedule">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="font-semibold">
                    {s.locationName}{' '}
                    {s.enabled ? null : <Badge tone="neutral">{t('row.paused')}</Badge>}
                  </p>
                  <p>
                    {s.weekday
                      ? t('row.whenWeekly', {
                          frequency,
                          weekday: t(`weekdays.${s.weekday}` as 'weekdays.1'),
                          time: hhmm(s.sendAtLocal),
                        })
                      : t('row.when', { frequency, time: hhmm(s.sendAtLocal) })}
                    {' · '}
                    {t('row.recipients', { count: s.recipients.length })}
                  </p>
                  {s.nextSendAt ? (
                    <p className="text-muted">
                      {t('row.next', {
                        date: new Date(s.nextSendAt).toLocaleString(i18n.language, {
                          timeZone: s.tz,
                          month: 'short',
                          day: 'numeric',
                          weekday: 'short',
                          hour: 'numeric',
                          minute: '2-digit',
                          timeZoneName: 'short',
                        }),
                      })}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    aria-label={t('row.previewFor', { location: s.locationName })}
                    loading={preview.isPending && preview.variables === s.id}
                    onClick={() =>
                      preview.mutate(s.id, {
                        onSuccess: () =>
                          toast.show({ message: t('row.previewSent'), tone: 'success' }),
                      })
                    }
                  >
                    {t('row.preview')}
                  </Button>
                  <Button
                    variant="secondary"
                    aria-label={t('row.editFor', { location: s.locationName })}
                    onClick={() => setEditing(s)}
                  >
                    {t('row.edit')}
                  </Button>
                  <Button
                    variant="secondary"
                    aria-label={t(s.enabled ? 'row.pauseFor' : 'row.resumeFor', {
                      location: s.locationName,
                    })}
                    onClick={() => setEnabled.mutate({ id: s.id, enabled: !s.enabled })}
                  >
                    {t(s.enabled ? 'row.pause' : 'row.resume')}
                  </Button>
                  <ConfirmDestructive
                    triggerLabel={t('row.remove')}
                    triggerAriaLabel={t('row.removeFor', { location: s.locationName })}
                    title={t('remove.title')}
                    description={t('remove.description', { location: s.locationName })}
                    confirmLabel={t('remove.confirm')}
                    cancelLabel={t('remove.cancel')}
                    triggerVariant="secondary"
                    onConfirm={() => remove.mutateAsync(s.id)}
                  />
                </div>
                {preview.isError && preview.variables === s.id ? (
                  <p role="alert">{t(errorKey(preview.error.message))}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {editing ? (
        <ScheduleDialog
          orgId={orgId}
          schedule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function ScheduleDialog({
  orgId,
  schedule,
  onClose,
}: {
  orgId: string;
  schedule: ReportSchedule | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin-reports');
  const save = useSaveSchedule(orgId);
  const { locations, location } = useCurrentLocation();
  const orgLocations = locations.filter((l) => l.org_id === orgId);
  const members = useQuery(membersQuery(orgId)).data ?? [];
  const [locationId, setLocationId] = useState(schedule?.locationId ?? location?.id ?? '');
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>(schedule?.frequency ?? 'weekly');
  const [weekday, setWeekday] = useState(schedule?.weekday ?? 1);
  const [time, setTime] = useState(schedule ? hhmm(schedule.sendAtLocal) : '08:00');
  const [recipients, setRecipients] = useState<string[]>(schedule?.recipients ?? []);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      {
        id: schedule?.id,
        locationId,
        frequency,
        weekday: frequency === 'weekly' ? weekday : null,
        sendAtLocal: time,
        recipients,
        enabled,
      },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog open onClose={onClose} title={t(schedule ? 'form.titleEdit' : 'form.titleNew')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Select
          label={t('form.location')}
          value={locationId}
          disabled={!!schedule}
          onChange={(e) => setLocationId(e.target.value)}
        >
          {orgLocations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <Select
          label={t('form.frequency')}
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as 'daily' | 'weekly')}
        >
          <option value="daily">{t('frequency.daily')}</option>
          <option value="weekly">{t('frequency.weekly')}</option>
        </Select>
        {frequency === 'weekly' ? (
          <Select
            label={t('form.weekday')}
            value={weekday}
            onChange={(e) => setWeekday(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <option key={d} value={d}>
                {t(`weekdays.${d}` as 'weekdays.1')}
              </option>
            ))}
          </Select>
        ) : null}
        <Input
          label={t('form.time')}
          type="time"
          required
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="font-medium">{t('form.recipients')}</legend>
          <p className="text-sm text-muted">{t('form.recipientsHint')}</p>
          {members
            .filter((m) => m.userId)
            .map((m) => (
              <Checkbox
                key={m.userId}
                label={m.displayName ?? m.email ?? m.userId!}
                checked={recipients.includes(m.userId!)}
                onChange={(e) =>
                  setRecipients((prev) =>
                    e.target.checked ? [...prev, m.userId!] : prev.filter((id) => id !== m.userId),
                  )
                }
              />
            ))}
        </fieldset>
        <Checkbox
          label={t('form.enabled')}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {save.error ? <p role="alert">{t(errorKey(save.error.message))}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('form.cancel')}
          </Button>
          <Button type="submit" loading={save.isPending} loadingLabel={t('form.saving')}>
            {t('form.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

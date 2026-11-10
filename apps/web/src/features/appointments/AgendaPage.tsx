import { errorCode } from '@qm/domain';
import {
  BigButton,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Spinner,
  useToast,
} from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../auth/current.ts';
import { canManageQueues } from '../admin/queues/api.ts';
import { addDays, localDate } from '../booking/slots.ts';
import {
  useAppointments,
  useCancelSeriesFrom,
  useLocationServices,
  useSeriesLinks,
  useStaffCancel,
} from './api.ts';
import { AgendaList } from './AgendaList.tsx';
import { BookDialog } from './BookDialog.tsx';
import { useDayWaitlist } from './waitlist.ts';
import { WaitlistPanel } from './WaitlistPanel.tsx';
import { AppointmentSearch } from './search/AppointmentSearch.tsx';

/** `/admin/appointments` (A-1): one day's appointments for the current location, with booking and cancelling. */
export function AgendaPage() {
  const { t } = useTranslation('appointments');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const toast = useToast();
  const tz = location?.tz ?? 'UTC';
  const [day, setDay] = useState(() => localDate(new Date(), tz));
  const [serviceId, setServiceId] = useState('');
  const [booking, setBooking] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const appointments = useAppointments(location?.id, day, day);
  const services = useLocationServices(location?.id);
  const waitlist = useDayWaitlist(location?.id, day);
  const cancel = useStaffCancel();
  const cancelSeries = useCancelSeriesFrom();
  const links = useSeriesLinks((appointments.data ?? []).map((r) => r.id));
  if (!location || !services.data) return <Skeleton label={t('agenda.loading')} rows={2} />;

  const names = new Map(services.data.map((s) => [s.id, s.name]));
  const rows = (appointments.data ?? []).filter((r) => !serviceId || r.service_id === serviceId);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <PageHeader
        title={t('agenda.title')}
        actions={<BigButton onClick={() => setBooking(true)}>{t('agenda.book')}</BigButton>}
      />
      <AppointmentSearch
        locationId={location.id}
        tz={tz}
        onPick={(hit) => {
          setDay(localDate(new Date(hit.starts_at), tz));
          setServiceId('');
          setHighlightId(hit.id);
        }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label={t('agenda.dayNav')} className="flex gap-2">
          <Button variant="secondary" onClick={() => setDay(addDays(day, -1))}>
            {t('agenda.prevDay')}
          </Button>
          <Button variant="secondary" onClick={() => setDay(localDate(new Date(), tz))}>
            {t('agenda.today')}
          </Button>
          <Button variant="secondary" onClick={() => setDay(addDays(day, 1))}>
            {t('agenda.nextDay')}
          </Button>
        </div>
        <Input
          label={t('agenda.date')}
          type="date"
          value={day}
          onChange={(e) => e.target.value && setDay(e.target.value)}
        />
        <Select
          label={t('agenda.service')}
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          <option value="">{t('agenda.allServices')}</option>
          {services.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
      {appointments.isError ? (
        <p role="alert">{t('agenda.loadFailed')}</p>
      ) : appointments.isPending ? (
        <Spinner label={t('agenda.loading')} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('agenda.empty')} />
      ) : (
        <AgendaList
          rows={rows}
          highlightId={highlightId}
          serviceNames={names}
          tz={tz}
          seriesOf={links.data}
          onCancelFollowing={(appointment, seriesId) =>
            cancelSeries.mutateAsync({ seriesId, from: localDate(appointment.starts_at, tz) }).then(
              (count) => toast.show({ message: t('agenda.series.followingToast', { count }) }),
              () => toast.show({ message: t('agenda.error.unknown'), tone: 'danger' }),
            )
          }
          onCancel={(appointment, reason) =>
            cancel.mutateAsync({ appointment, reason }).then(
              () => toast.show({ message: t('agenda.cancelledToast') }),
              (error: unknown) => {
                const code = errorCode(error);
                toast.show({
                  message: t(`agenda.error.${code}` as 'agenda.error.unknown', {
                    defaultValue: t('agenda.error.unknown'),
                  }),
                  tone: 'danger',
                });
              },
            )
          }
        />
      )}
      <WaitlistPanel
        rows={(waitlist.data ?? []).filter((r) => !serviceId || r.serviceId === serviceId)}
        serviceNames={names}
        tz={tz}
      />
      {booking ? (
        <BookDialog
          open
          onClose={() => setBooking(false)}
          location={{ id: location.id, slug: location.slug, tz }}
          services={services.data}
          canOverride={canManageQueues(org?.role)}
        />
      ) : null}
    </div>
  );
}

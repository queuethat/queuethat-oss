import { Card } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { localDate } from '../booking/slots.ts';
import { useAppointments, useLocationServices } from './api.ts';
import { AgendaList } from './AgendaList.tsx';

/** A compact "Today's appointments" list for the staff console; hidden when the day is empty. */
export function TodayPanel({ locationId, tz }: { locationId: string; tz: string }) {
  const { t } = useTranslation('appointments');
  const today = localDate(new Date(), tz);
  const appointments = useAppointments(locationId, today, today);
  const services = useLocationServices(locationId);
  const rows = (appointments.data ?? []).filter((r) => r.status === 'booked');
  if (rows.length === 0) return null;
  const names = new Map((services.data ?? []).map((s) => [s.id, s.name]));
  return (
    <Card role="region" aria-label={t('today.title')} className="mb-4 flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{t('today.title')}</h2>
      <AgendaList rows={rows} serviceNames={names} tz={tz} />
    </Card>
  );
}

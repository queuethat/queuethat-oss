import { errorCode } from '@qm/domain';
import {
  Badge,
  BigButton,
  Button,
  Card,
  ConfirmDestructive,
  EmptyState,
  Input,
  PageHeader,
  Skeleton,
  Spinner,
  useToast,
} from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { useLocationServices } from '../../appointments/api.ts';
import { formatWhen } from '../../booking/slots.ts';
import { canManageQueues } from '../queues/api.ts';
import { useCancelEvent, useEventAttendees, useEvents, type EventRow } from './api.ts';
import { EventForm } from './EventForm.tsx';

/** `/admin/events` (A-10): publish group and class events with a seat capacity, see who booked, cancel. */
export function EventsPage() {
  const { t, i18n } = useTranslation('appointments');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const toast = useToast();
  const events = useEvents(location?.id);
  const services = useLocationServices(location?.id);
  const cancel = useCancelEvent();
  const [form, setForm] = useState<EventRow | 'new' | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const attendees = useEventAttendees(openId);
  if (!location || !services.data) return <Skeleton label={t('events.loading')} rows={2} />;
  const tz = location.tz;
  const manager = canManageQueues(org?.role);
  const names = new Map(services.data.map((s) => [s.id, s.name]));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <PageHeader
        title={t('events.title')}
        actions={
          manager ? (
            <BigButton onClick={() => setForm('new')}>{t('events.create')}</BigButton>
          ) : null
        }
      />
      {events.isError ? (
        <p role="alert">{t('events.loadFailed')}</p>
      ) : events.isPending ? (
        <Skeleton label={t('events.loading')} rows={2} />
      ) : events.data.length === 0 ? (
        <EmptyState title={t('events.empty')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {events.data.map((e) => (
            <li key={e.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{e.title}</p>
                    <p className="text-muted">
                      {formatWhen(e.start, tz, i18n.language)} · {names.get(e.serviceId) ?? ''}
                    </p>
                    <p>{t('events.seats', { booked: e.booked, capacity: e.capacity })}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={e.status === 'cancelled' ? 'neutral' : e.public ? 'info' : 'neutral'}
                    >
                      {t(
                        e.status === 'cancelled'
                          ? 'events.status.cancelled'
                          : e.public
                            ? 'events.status.public'
                            : 'events.status.private',
                      )}
                    </Badge>
                    <Button
                      variant="secondary"
                      aria-label={t('events.attendeesFor', { title: e.title })}
                      aria-expanded={openId === e.id}
                      onClick={() => setOpenId(openId === e.id ? null : e.id)}
                    >
                      {t('events.attendees')}
                    </Button>
                    {manager && e.status === 'scheduled' ? (
                      <>
                        <Button
                          variant="secondary"
                          aria-label={t('events.editFor', { title: e.title })}
                          onClick={() => setForm(e)}
                        >
                          {t('events.editButton')}
                        </Button>
                        <ConfirmDestructive
                          triggerLabel={t('events.cancelEvent')}
                          triggerAriaLabel={`${t('events.cancelEvent')} ${e.title}`}
                          title={t('events.cancelTitle')}
                          description={t('events.cancelBody')}
                          confirmLabel={t('events.cancelConfirm')}
                          cancelLabel={t('events.cancelKeep')}
                          triggerVariant="secondary"
                          onConfirm={async () => {
                            try {
                              await cancel.mutateAsync({ eventId: e.id, reason: reason.trim() });
                              setReason('');
                              toast.show({ message: t('events.cancelledToast') });
                            } catch (error) {
                              toast.show({
                                message: t(
                                  errorCode(error) === 'not_found'
                                    ? 'events.error.not_found'
                                    : 'events.error.unknown',
                                ),
                                tone: 'danger',
                              });
                            }
                          }}
                        >
                          <Input
                            label={t('events.cancelReason')}
                            value={reason}
                            maxLength={200}
                            onChange={(ev) => setReason(ev.target.value)}
                          />
                        </ConfirmDestructive>
                      </>
                    ) : null}
                  </div>
                </div>
                {openId === e.id ? (
                  <div aria-label={t('events.attendeesFor', { title: e.title })} role="group">
                    {attendees.isError ? (
                      <p role="alert">{t('events.loadFailed')}</p>
                    ) : attendees.isPending ? (
                      <Spinner label={t('events.loading')} />
                    ) : attendees.data?.length ? (
                      <ul className="flex flex-col gap-1">
                        {attendees.data.map((a) => (
                          <li key={a.id}>
                            {t('events.attendee', { name: a.guest_name, count: a.seats })}
                            {a.status === 'cancelled' ? ` (${t('events.status.cancelled')})` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>{t('events.noAttendees')}</p>
                    )}
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {form ? (
        <EventForm
          onClose={() => setForm(null)}
          location={{ id: location.id, orgId: location.org_id, tz }}
          services={services.data}
          event={form === 'new' ? undefined : form}
        />
      ) : null}
    </div>
  );
}

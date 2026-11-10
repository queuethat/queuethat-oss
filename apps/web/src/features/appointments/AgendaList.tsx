import { Badge, Card, ConfirmDestructive, Input } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { formatTime } from '../booking/slots.ts';
import type { AppointmentRow } from './api.ts';

/**
 * Appointments grouped by the hour they start, on the location's clock. Cancel is offered only
 * for booked ones and always asks first (I-9).
 */
export function AgendaList({
  rows,
  serviceNames,
  tz,
  highlightId,
  onCancel,
  seriesOf,
  onCancelFollowing,
}: {
  rows: AppointmentRow[];
  serviceNames: Map<string, string>;
  tz: string;
  /** The row a search result opened this day for: marked and scrolled into view. */
  highlightId?: string | null;
  onCancel?: (row: AppointmentRow, reason: string) => Promise<unknown>;
  /** Appointment id to series id, for the rows that belong to a recurring series. */
  seriesOf?: Map<string, string>;
  /** Cancels this appointment and every later one of its series. */
  onCancelFollowing?: (row: AppointmentRow, seriesId: string) => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation('appointments');
  const [reason, setReason] = useState('');
  const hours = new Map<string, AppointmentRow[]>();
  for (const row of rows) {
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    }).format(new Date(row.starts_at));
    hours.set(hour, [...(hours.get(hour) ?? []), row]);
  }
  return (
    <div className="flex flex-col gap-4">
      {[...hours].map(([hour, list]) => (
        <section key={hour} aria-label={`${hour}:00`} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-muted">{`${hour}:00`}</h3>
          <ul className="flex flex-col gap-2">
            {list.map((row) => (
              <li
                key={row.id}
                aria-current={row.id === highlightId ? 'true' : undefined}
                ref={
                  row.id === highlightId
                    ? (el) => el?.scrollIntoView?.({ block: 'center' })
                    : undefined
                }
              >
                <Card
                  className={`flex flex-wrap items-center justify-between gap-3${row.id === highlightId ? ' outline outline-2 outline-primary' : ''}`}
                >
                  <div>
                    <p className="font-semibold">
                      {formatTime(row.starts_at, tz, i18n.language)}
                      {' · '}
                      {t('agenda.row', {
                        guest: row.guest_name ?? '',
                        service: serviceNames.get(row.service_id) ?? '',
                      })}
                    </p>
                    <Badge tone={row.status === 'booked' ? 'info' : 'neutral'}>
                      {t(`agenda.status.${row.status}` as 'agenda.status.booked')}
                    </Badge>
                    {seriesOf?.has(row.id) ? (
                      <Badge tone="neutral">{t('agenda.series.badge')}</Badge>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {onCancel && row.status === 'booked' ? (
                      <ConfirmDestructive
                        triggerLabel={t('agenda.cancel')}
                        triggerAriaLabel={`${t('agenda.cancel')} ${row.guest_name ?? ''}`}
                        title={t('agenda.cancelTitle')}
                        description={t('agenda.cancelBody')}
                        confirmLabel={t('agenda.cancelConfirm')}
                        cancelLabel={t('agenda.cancelKeep')}
                        triggerVariant="secondary"
                        onConfirm={async () => {
                          await onCancel(row, reason.trim());
                          setReason('');
                        }}
                      >
                        <Input
                          label={t('agenda.cancelReason')}
                          maxLength={200}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </ConfirmDestructive>
                    ) : null}
                    {onCancelFollowing && row.status === 'booked' && seriesOf?.get(row.id) ? (
                      <ConfirmDestructive
                        triggerLabel={t('agenda.series.cancelFollowing')}
                        triggerAriaLabel={t('agenda.series.cancelFollowingAria', {
                          guest: row.guest_name ?? '',
                        })}
                        title={t('agenda.series.followingTitle')}
                        description={t('agenda.series.followingBody')}
                        confirmLabel={t('agenda.series.followingConfirm')}
                        cancelLabel={t('agenda.cancelKeep')}
                        triggerVariant="secondary"
                        onConfirm={() => onCancelFollowing(row, seriesOf.get(row.id)!)}
                      />
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

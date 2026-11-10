import type { Database } from '@qm/db-types';
import { buildIcs } from '@qm/domain';
import { Button, Card } from '@qm/ui';
import { lazy, Suspense } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { QuietBoundary } from '../../components/QuietBoundary.tsx';
import { useNow } from '../../lib/now.ts';
import { localWhen } from './hours.ts';

// The QR encoder is ~6 KB gzip and only needed once the guest opens the page's QR: off the budget.
const TicketQr = lazy(() => import('@qm/ui/qr').then((m) => ({ default: m.TicketQr })));

type VisitInfoData = Database['api']['CompositeTypes']['visit_info'];
interface Hours {
  open_now?: boolean;
  next_change?: string | null;
  tz?: string;
}

/** Today's hours in a sentence, or null when the location has no hours to speak of. */
export function hoursSentence(
  hours: Hours | null,
  now: number,
  locale: string,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string | null {
  // Open with no change coming means no weekly hours are set (open all day): nothing to say.
  if (!hours?.next_change || hours.open_now === undefined) return null;
  const { time, day } = localWhen(hours.next_change, now, hours.tz ?? 'UTC', locale);
  const key = hours.open_now ? 'openUntil' : 'opensAt';
  return day ? t(`info.${key}Later`, { day, time }) : t(`info.${key}`, { time });
}

/** Default length of a calendar entry; a visit has no fixed one. */
const CALENDAR_MINUTES = 30;
const REMINDER_MINUTES = 15;

/** Hands the browser a generated .ics: no server, and no token in any URL a calendar could sync (G-8). */
function downloadCalendar(info: VisitInfoData, summary: string, description: string) {
  const ics = buildIcs({
    uid: `${info.scan_code ?? crypto.randomUUID()}@queue-management`,
    start: info.scheduled_at!,
    durationMinutes: CALENDAR_MINUTES,
    summary,
    location: [info.location_name, info.address].filter(Boolean).join(', '),
    description,
    alarmMinutes: REMINDER_MINUTES,
  });
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'visit.ics';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * G-6, G-7, G-8: "About this place" (address with a directions link, phone, today's hours) and the
 * ticket QR for the counter. Both come from api.get_visit_info and carry nothing about the guest.
 */
export function VisitInfo({ info, ticket }: { info: VisitInfoData; ticket: string }) {
  const { t, i18n } = useTranslation('guest-info');
  const now = useNow(60_000);
  const hours = hoursSentence(
    (info.hours_today as Hours | null) ?? null,
    now,
    i18n.language,
    t as (key: string, vars?: Record<string, unknown>) => string,
  );
  const phone = info.phone?.trim() ?? '';
  const tel = phone.replace(/[^\d+]/g, '');
  const hasAbout = Boolean(info.address || phone || hours);
  const external = { target: '_blank', rel: 'noopener noreferrer' } as const;
  const link = 'inline-flex min-h-12 items-center text-primary underline';

  return (
    <>
      {hasAbout ? (
        <Card>
          <details>
            <summary className="flex min-h-12 cursor-pointer items-center font-semibold">
              {t('info.title')}
            </summary>
            <div className="flex flex-col gap-1 pb-2">
              {info.address ? (
                <p>
                  {info.address}
                  {info.directions_url ? (
                    <>
                      {' '}
                      <a href={info.directions_url} className={link} {...external}>
                        {t('info.directions')}
                      </a>
                    </>
                  ) : null}
                </p>
              ) : null}
              {tel ? (
                <p>
                  <a href={`tel:${tel}`} className={link}>
                    {t('info.call', { phone })}
                  </a>
                </p>
              ) : null}
              {hours ? <p data-testid="hours">{hours}</p> : null}
            </div>
          </details>
        </Card>
      ) : null}
      {info.scheduled_at ? (
        <Button
          variant="secondary"
          onClick={() =>
            downloadCalendar(
              info,
              t('calendar.summary', { place: info.location_name ?? '' }),
              [info.address, t('calendar.note')].filter(Boolean).join('\n'),
            )
          }
        >
          {t('calendar.add')}
        </Button>
      ) : null}
      {info.scan_code ? (
        <Card>
          <details>
            <summary className="flex min-h-12 cursor-pointer items-center font-semibold">
              {t('qr.title')}
            </summary>
            <div className="flex flex-col items-center gap-2 pb-2">
              <p className="text-center text-muted">{t('qr.hint')}</p>
              <QuietBoundary>
                <Suspense fallback={null}>
                  <TicketQr
                    value={`qm:${info.scan_code}`}
                    ticket={ticket}
                    code={info.scan_code}
                    label={t('qr.label', { ticket })}
                  />
                </Suspense>
              </QuietBoundary>
            </div>
          </details>
        </Card>
      ) : null}
    </>
  );
}

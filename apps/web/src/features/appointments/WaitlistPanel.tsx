import { Badge, Card } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { formatTime } from '../booking/slots.ts';
import type { WaitlistRow } from './waitlist.ts';

/** The day's slot waitlist (A-9): how many guests wait, for which service and times, and who holds an offer. */
export function WaitlistPanel({
  rows,
  serviceNames,
  tz,
}: {
  rows: WaitlistRow[];
  serviceNames: Map<string, string>;
  tz: string;
}) {
  const { t, i18n } = useTranslation('appointments');
  if (rows.length === 0) return null;
  return (
    <section aria-label={t('waitlist.title')} className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{t('waitlist.heading', { count: rows.length })}</h2>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.id}>
            <Card className="flex flex-wrap items-center justify-between gap-3">
              <p>
                <span className="font-semibold">{r.name}</span>
                {' · '}
                {serviceNames.get(r.serviceId) ?? ''}
                {' · '}
                {r.window
                  ? t('waitlist.window', {
                      from: formatTime(r.window.start, tz, i18n.language),
                      to: formatTime(r.window.end, tz, i18n.language),
                    })
                  : t('waitlist.anyTime')}
              </p>
              <Badge tone={r.status === 'offered' ? 'info' : 'neutral'}>
                {r.status === 'offered' && r.offerExpiresAt
                  ? t('waitlist.offeredUntil', {
                      time: formatTime(r.offerExpiresAt, tz, i18n.language),
                    })
                  : t('waitlist.waiting')}
              </Badge>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

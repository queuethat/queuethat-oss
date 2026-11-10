import { TicketNumber } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { formatAsOf } from '../../../lib/live.ts';
import { QrSvg } from '../QrSvg.tsx';

export interface Slip {
  location: string;
  queue: string;
  ticket: string;
  /** The link to the guest's status page, when the join returned one. */
  url: string | null;
  tz: string;
  /** Roll width in mm; 80 when unset. */
  paper?: 58 | 80;
  /** Optional line at the bottom, from the location's print settings. */
  footer?: string | null;
}

/**
 * The paper slip for 58 mm and 80 mm thermal printers. Hidden on screen; print CSS (styles.css,
 * `.kiosk-slip`) shows only this, in a column that fits the narrower paper.
 */
export function TicketSlip({ slip }: { slip: Slip }) {
  const { t, i18n } = useTranslation('kiosk');
  return (
    <section
      className="kiosk-slip"
      data-testid="kiosk-slip"
      data-paper={slip.paper ?? 80}
      aria-hidden="true"
    >
      <p className="kiosk-slip-location">{slip.location}</p>
      <p className="kiosk-slip-label">{t('print.slip.ticket')}</p>
      <p className="kiosk-slip-ticket">
        <TicketNumber ticket={slip.ticket} size="print" />
      </p>
      <p>{slip.queue}</p>
      <p>
        {t('print.slip.joined', {
          time: formatAsOf(new Date().toISOString(), i18n.language, slip.tz),
        })}
      </p>
      {slip.url ? (
        <>
          <QrSvg url={slip.url} label={t('done.qrAlt')} className="kiosk-slip-qr" />
          <p>{t('print.slip.scan')}</p>
        </>
      ) : null}
      {slip.footer ? <p className="kiosk-slip-footer">{slip.footer}</p> : null}
    </section>
  );
}

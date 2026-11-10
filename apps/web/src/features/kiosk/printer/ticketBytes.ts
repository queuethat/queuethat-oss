import { encodeEscPos } from '@qm/domain';
import type { TFunction } from 'i18next';
import { formatAsOf } from '../../../lib/live.ts';
import type { Slip } from '../print/TicketSlip.tsx';

/** The slip as ESC/POS bytes, labelled in the kiosk's current language. */
export function ticketBytes(slip: Slip, t: TFunction<'kiosk'>, language: string): Uint8Array {
  return encodeEscPos({
    location: slip.location,
    label: t('print.slip.ticket'),
    ticket: slip.ticket,
    queue: slip.queue,
    joined: t('print.slip.joined', {
      time: formatAsOf(new Date().toISOString(), language, slip.tz),
    }),
    url: slip.url,
    scanCaption: t('print.slip.scan'),
    footer: slip.footer,
    paper: slip.paper,
  });
}

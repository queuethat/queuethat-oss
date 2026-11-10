/** How an SMS body is encoded and how many billable segments it takes. */
export interface SmsSegments {
  encoding: 'gsm7' | 'ucs2';
  /** Length in the encoding's units: GSM-7 extension characters and emoji count 2. */
  chars: number;
  /** 0 for empty text. */
  segments: number;
}

const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM7_EXTENDED = new Set('^{}\\[~]|€\f');

/**
 * Counts SMS segments. GSM-7 holds 160 units in one segment and 153 per segment when split;
 * UCS-2 (any character outside GSM-7) holds 70, and 67 when split. Unicode code units are
 * counted as the network does, so one emoji is 2.
 */
export function smsSegments(text: string): SmsSegments {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7_BASIC.has(ch)) units += 1;
    else if (GSM7_EXTENDED.has(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'gsm7', chars: units, segments: split(units, 160, 153) };
  const ucs2 = text.length; // UTF-16 code units
  return { encoding: 'ucs2', chars: ucs2, segments: split(ucs2, 70, 67) };
}

function split(units: number, single: number, multi: number): number {
  if (units === 0) return 0;
  return units <= single ? 1 : Math.ceil(units / multi);
}

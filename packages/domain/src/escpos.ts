/** What a kiosk ticket carries; the caller supplies every label already translated. */
export interface EscPosTicket {
  location: string;
  /** The small caption above the number, e.g. "Your ticket". */
  label: string;
  ticket: string;
  queue: string;
  /** The "Joined at ..." line, already formatted for the location's timezone. */
  joined: string;
  /** Printed as a QR code by the printer itself; null skips the code and its caption. */
  url: string | null;
  scanCaption: string;
  footer?: string | null;
  /** Roll width in mm; 80 when unset. */
  paper?: 58 | 80;
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
/** Characters per line in the printer's default font A: 58 mm rolls fit 32, 80 mm rolls 48. */
const COLUMNS = { 58: 32, 80: 48 } as const;
/** The longest URL a QR code in the printer's model 2 store command accepts (7089 bits, level M). */
const QR_MAX_BYTES = 1273;

/**
 * Printers ship with a single-byte code page, so text is reduced to printable ASCII: accents are
 * dropped ("Café" -> "Cafe") and anything else becomes "?". Output never exceeds one byte per char.
 */
export function toPrinterText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?')
    .trim();
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of toPrinterText(text).split(' ')) {
    if (word === '') continue;
    let rest = word;
    while (rest.length > width) {
      if (line) lines.push(line);
      line = '';
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Encodes a kiosk ticket as ESC/POS bytes for a thermal receipt printer: location, a large ticket
 * number, the queue, the join time, a native QR code to the guest's status page, then a partial cut.
 * Pure and deterministic, so the output is pinned by a golden fixture.
 */
export function encodeEscPos(ticket: EscPosTicket): Uint8Array {
  const out: number[] = [];
  const columns = COLUMNS[ticket.paper ?? 80];
  const raw = (...bytes: number[]) => out.push(...bytes);
  const text = (value: string, width: number = columns) => {
    for (const line of wrap(value, width)) {
      for (const ch of line) out.push(ch.charCodeAt(0));
      out.push(LF);
    }
  };

  raw(ESC, 0x40); // initialise
  raw(ESC, 0x61, 0x01); // centre
  raw(ESC, 0x45, 0x01); // bold on
  raw(GS, 0x21, 0x11); // double width and height
  text(ticket.location, columns / 2);
  raw(GS, 0x21, 0x00, ESC, 0x45, 0x00);
  text(ticket.label);
  raw(GS, 0x21, 0x44); // 5x wide, 5x tall: the number is what a guest looks for
  raw(ESC, 0x45, 0x01);
  text(ticket.ticket, Math.floor(columns / 5));
  raw(GS, 0x21, 0x00, ESC, 0x45, 0x00);
  text(ticket.queue);
  text(ticket.joined);

  const url = ticket.url === null ? null : new TextEncoder().encode(ticket.url);
  if (url && url.length <= QR_MAX_BYTES) {
    raw(LF);
    raw(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // model 2
    raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06); // module size 6
    raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31); // error correction M
    const len = url.length + 3;
    raw(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...url); // store
    raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // print
    text(ticket.scanCaption);
  }
  if (ticket.footer) text(ticket.footer);

  raw(ESC, 0x61, 0x00);
  raw(ESC, 0x64, 0x04); // feed past the cutter
  raw(GS, 0x56, 0x42, 0x00); // partial cut
  return Uint8Array.from(out);
}

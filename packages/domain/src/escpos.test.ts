import { describe, expect, it } from 'vitest';
import { encodeEscPos, toPrinterText, type EscPosTicket } from './escpos.ts';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const hexOf = (text: string) => hex(new TextEncoder().encode(text));
const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

const TICKET: EscPosTicket = {
  location: 'Main',
  label: 'Your ticket',
  ticket: 'A007',
  queue: 'Walk-in',
  joined: 'Joined at 9:30 AM',
  url: 'https://q.test/v/abc',
  scanCaption: 'Scan to follow',
  footer: null,
  paper: 80,
};

describe('encodeEscPos', () => {
  it('matches the golden fixture', () => {
    expect(hex(encodeEscPos(TICKET))).toBe(
      [
        '1b40', // init
        '1b6101', // centre
        '1b4501', // bold
        '1d2111', // 2x2
        '4d61696e0a', // "Main\n"
        '1d21001b4500', // normal
        '596f7572207469636b65740a', // "Your ticket\n"
        '1d2144', // large
        '1b4501',
        '413030370a', // "A007\n"
        '1d21001b4500',
        '57616c6b2d696e0a', // "Walk-in\n"
        '4a6f696e656420617420393a333020414d0a', // "Joined at 9:30 AM\n"
        '0a', // gap before the code
        '1d286b0400314132' + '00', // QR model 2
        '1d286b0300314306', // module size
        '1d286b0300314531', // error correction
        '1d286b17003150' + '30' + hexOf(TICKET.url!), // store (len 20 + 3)
        '1d286b0300315130', // print
        '5363616e20746f20666f6c6c6f770a', // "Scan to follow\n"
        '1b6100', // left
        '1b6404', // feed
        '1d564200', // cut
      ].join(''),
    );
  });

  it('skips the QR code and caption without a link', () => {
    const bytes = hex(encodeEscPos({ ...TICKET, url: null }));
    expect(bytes).not.toContain('1d286b');
    expect(bytes).not.toContain(hexOf('Scan to follow'));
  });

  it('skips the QR code when the link cannot fit in one', () => {
    const bytes = hex(encodeEscPos({ ...TICKET, url: `https://q.test/${'a'.repeat(1300)}` }));
    expect(bytes).not.toContain('1d286b');
  });

  it('wraps to the paper width', () => {
    const queue = 'word '.repeat(20).trim();
    const lines = (paper: 58 | 80) =>
      latin1(encodeEscPos({ ...TICKET, queue, url: null, paper }))
        .split('\n')
        .map((l) => l.replace(/[^\x20-\x7e]/g, ''))
        .filter((l) => l.includes('word'));
    expect(Math.max(...lines(58).map((l) => l.length))).toBeLessThanOrEqual(32);
    expect(Math.max(...lines(80).map((l) => l.length))).toBeLessThanOrEqual(48);
    expect(lines(58).length).toBeGreaterThan(lines(80).length);
  });

  it('never emits a byte the printer would read as a command from guest text', () => {
    const bytes = encodeEscPos({ ...TICKET, queue: 'x\u001b@\u001dV\u0000y', url: null });
    expect(hex(bytes)).toContain(hexOf('x?@?V?y'));
    // only our own two ESC/GS-prefixed commands per line; the injected ones are gone
    expect(Array.from(bytes).filter((b) => b === 0x1b).length).toBe(
      Array.from(encodeEscPos({ ...TICKET, queue: 'xy', url: null })).filter((b) => b === 0x1b)
        .length,
    );
  });
});

describe('toPrinterText', () => {
  it('drops accents and replaces what a code page cannot show', () => {
    expect(toPrinterText('Café Ñandú')).toBe('Cafe Nandu');
    expect(toPrinterText('Zoë 理髪')).toBe('Zoe ??');
  });
});

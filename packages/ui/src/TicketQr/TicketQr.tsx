import { qrMatrix } from './matrix.ts';

/** Quiet zone in modules; the QR spec asks for 4. */
const QUIET = 4;

export interface TicketQrProps {
  /** What the QR encodes. Never a guest token: use the visit's scan code (`qm:<scan_code>`). */
  value: string;
  /** The ticket, shown as text under the code. */
  ticket: string;
  /** The code in text for manual entry, shown under the ticket. */
  code: string;
  /** Accessible name of the image, e.g. "QR code for ticket A042". */
  label: string;
}

/**
 * A large, high-contrast QR of `value` drawn as one SVG path (no canvas, no network), with the
 * ticket and the code underneath so staff can type it when a scan fails. Always black on white,
 * whatever the theme, because scanners need the contrast.
 */
export function TicketQr({ value, ticket, code, label }: TicketQrProps) {
  const matrix = qrMatrix(value);
  const size = matrix.length + QUIET * 2;
  const path = matrix
    .flatMap((row, r) => row.map((dark, c) => (dark ? `M${c + QUIET} ${r + QUIET}h1v1h-1z` : '')))
    .join('');
  return (
    <figure className="flex flex-col items-center gap-2">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${size} ${size}`}
        shapeRendering="crispEdges"
        className="w-full max-w-72 rounded-card bg-white"
        data-testid="ticket-qr"
      >
        <rect width={size} height={size} fill="#fff" />
        <path d={path} fill="#000" />
      </svg>
      <figcaption className="text-center">
        <span className="block text-xl font-bold">{ticket}</span>
        <span className="block font-mono text-lg tracking-widest" data-testid="ticket-qr-code">
          {code}
        </span>
      </figcaption>
    </figure>
  );
}

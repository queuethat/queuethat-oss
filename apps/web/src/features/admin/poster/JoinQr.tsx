import { qrPath } from './qr.ts';

/**
 * The QR code for a join page address, drawn here as one SVG path so no outside service sees it.
 * Always black on white: scanners need the contrast whatever the theme.
 */
export function JoinQr({
  url,
  label,
  className,
}: {
  url: string;
  label: string;
  className?: string;
}) {
  const qr = qrPath(url);
  return (
    // eslint-disable-next-line no-restricted-syntax -- data-driven drawing, not an icon
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label={label}
      className={className}
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#000" />
    </svg>
  );
}

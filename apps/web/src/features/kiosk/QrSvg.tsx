import { qrPath } from '../admin/poster/qr.ts';

/** A QR code for `url`, drawn here so no outside service sees the link. Always black on white, as paper is. */
export function QrSvg({
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

import { encode } from 'uqr';

/**
 * The QR code for `text` as one SVG path in module units, with a 4-module quiet zone. Error
 * correction M survives a scuffed or partly covered poster.
 */
export function qrPath(text: string): { size: number; path: string; modules: boolean[][] } {
  const { data, size } = encode(text, { ecc: 'M', border: 4 });
  let path = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { size, path, modules: data };
}

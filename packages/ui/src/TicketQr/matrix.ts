import qrcode from 'qrcode-generator';

/**
 * The QR module matrix for `text` (true = dark), error correction M. Pure and synchronous; the
 * component and its decoding test share it.
 */
export function qrMatrix(text: string): boolean[][] {
  const code = qrcode(0, 'M'); // type 0 picks the smallest version that fits
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => code.isDark(r, c)),
  );
}

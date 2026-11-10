/** A scan code is 10 characters of Crockford base32 (no I, L, O, U). */
const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * The scan code in what a camera read or staff typed: the `qm:<code>` a guest's QR holds, or the
 * bare code printed under it. Case and spaces are ignored. Anything else (a URL, another
 * system's QR) is null.
 */
export function parseScanCode(text: string): string | null {
  const trimmed = text.trim().toUpperCase().replace(/\s+/g, '');
  const code = trimmed.startsWith('QM:') ? trimmed.slice(3) : trimmed;
  return CODE.test(code) ? code : null;
}

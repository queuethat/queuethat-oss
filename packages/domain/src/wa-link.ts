/**
 * The click-to-chat link for a guest's phone: `https://wa.me/<digits>?text=<message>`. wa.me wants
 * the number as digits only (no plus or spaces) in international format, which E.164 already is.
 * Returns null for anything that isn't E.164, so a bad number never builds a link.
 */
export function waLink(phoneE164: string, text: string): string | null {
  if (!/^\+[1-9][0-9]{6,14}$/.test(phoneE164)) return null;
  return `https://wa.me/${phoneE164.slice(1)}?text=${encodeURIComponent(text)}`;
}

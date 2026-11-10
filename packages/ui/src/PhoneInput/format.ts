import { AsYouType, type CountryCode } from 'libphonenumber-js/min';

/** Characters that carry meaning in a phone number; everything else is formatting. */
const significant = /[\d+]/;

export function countSignificant(text: string): number {
  let n = 0;
  for (const ch of text) if (significant.test(ch)) n++;
  return n;
}

/** Digits plus a leading '+', which is what the user actually typed. */
export function strip(text: string): string {
  const digits = text.replace(/\D/g, '');
  return text.trimStart().startsWith('+') ? `+${digits}` : digits;
}

/** Index just after the `n`-th significant character of `text`. */
export function caretAfter(text: string, n: number): number {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (significant.test(text[i]!) && ++seen === n) return i + 1;
  }
  return text.length;
}

export interface Edit {
  text: string;
  caret: number;
  country: CountryCode | undefined;
}

/**
 * Re-formats an edited value and keeps the caret beside the same digit it was next to, so a
 * one-digit fix never means retyping (J-17). `previous` is the formatted value before the edit:
 * when a deletion removed only a space or bracket, the digit next to it goes instead, otherwise
 * the formatter would put the space straight back and the key would seem dead.
 */
export function applyEdit(
  previous: string,
  raw: string,
  caret: number,
  country: CountryCode,
  inputType?: string,
): Edit {
  let cleaned = strip(raw);
  let before = countSignificant(raw.slice(0, caret));
  const deleting = inputType === 'deleteContentBackward' || inputType === 'deleteContentForward';
  if (deleting && cleaned === strip(previous) && cleaned.length > 0) {
    const at = inputType === 'deleteContentBackward' ? before - 1 : before;
    if (at >= 0 && at < cleaned.length) {
      cleaned = cleaned.slice(0, at) + cleaned.slice(at + 1);
      if (inputType === 'deleteContentBackward') before -= 1;
    }
  }
  const formatter = new AsYouType(country);
  const text = cleaned ? formatter.input(cleaned) : '';
  // Forward Delete keeps the caret against the next digit, not before a space the formatter added.
  const nextCaret =
    inputType === 'deleteContentForward' && before < countSignificant(text)
      ? caretAfter(text, before + 1) - 1
      : caretAfter(text, before);
  return { text, caret: nextCaret, country: formatter.getCountry() };
}

// Amounts are integer minor units in the database. These currencies all have two decimals, which is
// all the policy form offers; a zero-decimal currency would need its own exponent.
export const CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** "12.50" or "12" to 1250 minor units; null when it isn't a positive amount with at most 2 decimals. */
export function toMinor(text: string): number | null {
  const m = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return minor > 0 ? minor : null;
}

/** 1250 to "12.50", for an input's initial value. */
export function fromMinor(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** A localized amount such as "$12.50". */
export function formatMoney(minor: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(minor / 100);
}

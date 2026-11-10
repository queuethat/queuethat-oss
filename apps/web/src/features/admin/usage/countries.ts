/** ISO countries an org can allow for paid messages; matches app.dial_codes, which the database checks against. */
export const COUNTRIES = [
  'US',
  'CA',
  'GB',
  'IE',
  'AU',
  'NZ',
  'FR',
  'DE',
  'ES',
  'IT',
  'NL',
  'BE',
  'CH',
  'AT',
  'DK',
  'SE',
  'NO',
  'FI',
  'PT',
  'PL',
  'MX',
  'BR',
  'AR',
  'CL',
  'CO',
  'IN',
  'JP',
  'KR',
  'SG',
  'HK',
  'AE',
  'SA',
  'IL',
  'ZA',
  'NG',
  'KE',
  'PH',
  'ID',
  'MY',
  'TH',
] as const;

/** Share of the daily cap at which the banner appears (matches the 80% alert email). */
export const WARN_PCT = 80;

export const percentOf = (sent: number, cap: number) =>
  cap <= 0 ? 100 : Math.round((sent / cap) * 100);

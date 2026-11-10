/**
 * Whole-message carrier keywords for inbound SMS (compliance review sections 4 and 9). The same
 * sets live in SQL as `private.inbound_keyword_kind`; keywords.drift.test.ts keeps them equal.
 * Two-way commands (commands.ts) must stay disjoint from every word here.
 */
export type InboundKeywordKind = 'optout' | 'optin' | 'help';

/** Normalised forms: uppercase, letters and digits only, so "Stop all!" is STOPALL. */
export const OPTOUT_KEYWORDS = [
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'REVOKE',
  'OPTOUT',
] as const;
/** YES is not here: it answers other questions too (a staff-number confirmation), so it must not lift a STOP. */
export const OPTIN_KEYWORDS = ['START', 'UNSTOP'] as const;
export const HELP_KEYWORDS = ['HELP', 'INFO'] as const;

export function normalizeKeyword(body: string): string {
  return body.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Whole-message free-text opt-outs (compliance review M6), already normalised by `normalizePhrase`.
 * Conservative on purpose: the entire message must be one of these (a bare "no" is never one), so
 * "stop by at 5" or "can you remove me from the 3pm slot" opt nobody out. The SQL twin is
 * `private.inbound_optout_phrase`; the drift test keeps them equal.
 */
export const OPTOUT_PHRASES_EN = [
  'stop',
  'stop it',
  'stop texting',
  'stop texting me',
  'stop messaging',
  'stop messaging me',
  'stop sending texts',
  'stop sending me texts',
  'stop sending messages',
  'stop sending me messages',
  'remove me',
  'remove my number',
  'remove me from the list',
  'remove me from your list',
  'unsubscribe me',
  'do not text me',
  'dont text me',
  'do not message me',
  'dont message me',
  'no more texts',
  'no more messages',
  'take me off',
  'take me off the list',
  'take me off your list',
  'opt me out',
] as const;
export const OPTOUT_PHRASES_ES = [
  'pare',
  'paren',
  'baja',
  'de baja',
  'dame de baja',
  'darme de baja',
  'no mas',
  'no mas mensajes',
  'no mas textos',
  'no me escriban mas',
  'no me envien mas mensajes',
  'deja de escribirme',
  'dejen de escribirme',
  'dejen de enviarme mensajes',
] as const;

/**
 * Lowercase, the Spanish accents folded, apostrophes dropped, every other non-alphanumeric run a single space, and a leading
 * or trailing "please" / "thanks" (EN, ES) removed. Mirrors `private.inbound_optout_phrase`.
 */
export function normalizePhrase(body: string): string {
  const folded = body
    .toLowerCase()
    .replace(/[áéíóúñü]/g, (c) => 'aeiounu'['áéíóúñü'.indexOf(c)] ?? c);
  return folded
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(please|por favor) /, '')
    .replace(/ (please|por favor|thanks|thank you|gracias)$/, '');
}

/** The language of a free-text opt-out (to pick the reply), or null when the text is anything else. */
export function classifyOptOutPhrase(body: string): 'en' | 'es' | null {
  const phrase = normalizePhrase(body);
  if ((OPTOUT_PHRASES_ES as readonly string[]).includes(phrase)) return 'es';
  if ((OPTOUT_PHRASES_EN as readonly string[]).includes(phrase)) return 'en';
  return null;
}

/** The kind of a whole-message keyword or free-text opt-out, or null when the text is anything else. */
export function classifyKeyword(body: string): InboundKeywordKind | null {
  if (classifyOptOutPhrase(body)) return 'optout';
  const word = normalizeKeyword(body);
  if ((OPTOUT_KEYWORDS as readonly string[]).includes(word)) return 'optout';
  if ((OPTIN_KEYWORDS as readonly string[]).includes(word)) return 'optin';
  if ((HELP_KEYWORDS as readonly string[]).includes(word)) return 'help';
  return null;
}

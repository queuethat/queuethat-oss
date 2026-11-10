import { CONSENT_TEXTS } from './generated/consent-texts.ts';

export type ConsentChannel = 'sms' | 'whatsapp';

/** The location as guests see it: `name` and `contact` from get_location_public or get_visit_info. */
export interface ConsentBusiness {
  name: string;
  contact: string | null;
}

export interface ConsentText {
  version: number;
  locale: string;
  text: string;
}

/**
 * The newest published transactional opt-in text for `channel` and `locale`, filled in exactly as
 * private.render_consent_text does on the server (the location's name and contact, or its name
 * when there is no contact). Null when none is published.
 */
export function consentText(
  channel: ConsentChannel,
  locale: string,
  business: ConsentBusiness,
): ConsentText | null {
  const row = CONSENT_TEXTS.filter(
    (t) => t.channel === channel && t.purpose === 'transactional' && t.locale === locale,
  ).sort((a, b) => b.version - a.version)[0];
  if (!row) return null;
  const text = row.body
    .replaceAll('{{business_name}}', business.name)
    .replaceAll('{{support_contact}}', business.contact ?? business.name);
  return { version: row.version, locale, text };
}

/** sha256 hex of `text`: what api.guest_grant_consent compares against its own rendering. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

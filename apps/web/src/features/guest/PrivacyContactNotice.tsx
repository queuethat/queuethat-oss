import { useTranslation } from '../../lib/translation.tsx';

/** The business's privacy officer as the database returns it for the guest notice. */
export interface PrivacyContactInfo {
  name: string;
  email: string;
  phone?: string | undefined;
}

/** Narrows the untyped json from `api.get_location_public` to what the notice can show. */
export function parsePrivacyContact(value: unknown): PrivacyContactInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x !== '' ? x : undefined);
  const name = str(v.name);
  const email = str(v.email);
  return name && email ? { name, email, phone: str(v.phone) } : null;
}

/**
 * Who to ask about privacy at this business. Renders nothing when the business has not recorded
 * a privacy officer. The data comes from the database; nothing here decides what is shown.
 */
export function PrivacyContactNotice({ contact }: { contact: PrivacyContactInfo | null }) {
  const { t } = useTranslation('guest');
  if (!contact) return null;
  return (
    <p data-testid="privacy-contact-notice" className="flex flex-col">
      <span>{t('join.privacyContact.intro', { name: contact.name })}</span>
      <a
        href={`mailto:${encodeURIComponent(contact.email).replace('%40', '@')}`}
        className="inline-flex min-h-target items-center underline"
      >
        {contact.email}
      </a>
      {contact.phone ? (
        <a
          href={`tel:${contact.phone.replace(/[^+\d]/g, '')}`}
          className="inline-flex min-h-target items-center underline"
        >
          {contact.phone}
        </a>
      ) : null}
    </p>
  );
}

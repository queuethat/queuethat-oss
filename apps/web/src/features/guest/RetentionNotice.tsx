import { useTranslation } from '../../lib/translation.tsx';
import { LEGAL_URLS } from '../marketing/company.ts';

/**
 * One sentence telling a guest how long the business keeps their visit details, linked to the
 * privacy text. Renders nothing until the period is known. The period comes from the database;
 * nothing here decides it.
 */
export function RetentionNotice({ business, days }: { business: string; days: number | null }) {
  const { t } = useTranslation('guest');
  if (!days) return null;
  return (
    <p data-testid="retention-notice" className="flex flex-col">
      {t('join.retention.notice', { business, count: days })}
      <a
        href={LEGAL_URLS.privacy}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-target items-center underline"
      >
        {t('join.retention.privacyLink')}
      </a>
    </p>
  );
}

import { useTranslation } from '../../lib/translation.tsx';
import { legalUrls } from '../marketing/company.ts';

/**
 * One sentence telling a guest how long the business keeps their visit details, linked to the
 * privacy text. Renders nothing until the period is known. The period comes from the database;
 * nothing here decides it.
 */
export function RetentionNotice({ business, days }: { business: string; days: number | null }) {
  const { t } = useTranslation('guest');
  if (!days) return null;
  const { privacy } = legalUrls();
  return (
    <p data-testid="retention-notice" className="flex flex-col">
      {t('join.retention.notice', { business, count: days })}
      {privacy ? (
        <a
          href={privacy}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-target items-center underline"
        >
          {t('join.retention.privacyLink')}
        </a>
      ) : null}
    </p>
  );
}

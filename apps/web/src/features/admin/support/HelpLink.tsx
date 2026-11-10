import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import { HELP_ANCHOR } from './HelpArticles.tsx';

/** Header link on every admin page to the help articles on the Help page. */
export function HelpLink() {
  const { t } = useTranslation('admin-nav');
  return (
    <Link
      to="/admin/help"
      hash={HELP_ANCHOR}
      className="inline-flex min-h-target shrink-0 items-center whitespace-nowrap text-sm font-medium underline"
    >
      {t('help')}
    </Link>
  );
}

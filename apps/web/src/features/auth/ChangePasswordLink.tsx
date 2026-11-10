import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../lib/translation.tsx';
import { useSession } from './api.ts';

/** Link to the change-password form, shown beside Sign out. Renders nothing when signed out. */
export function ChangePasswordLink() {
  const { t } = useTranslation('auth');
  const session = useSession();
  if (!session.data) return null;
  return (
    <Link
      to="/auth/change-password"
      className="inline-flex min-h-target shrink-0 items-center whitespace-nowrap text-sm font-medium underline"
    >
      {t('change.link')}
    </Link>
  );
}

import { Button } from '@qm/ui';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from '../../lib/translation.tsx';
import { useSession, useSignOut } from './api.ts';

/** Signs this device out and returns to sign-in. Renders nothing when signed out. */
export function SignOutButton() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const session = useSession();
  const signOut = useSignOut();
  if (!session.data) return null;
  return (
    <Button
      variant="secondary"
      // Stays on one line beside a long location name on a 375px phone.
      className="shrink-0 whitespace-nowrap"
      loading={signOut.isPending}
      loadingLabel={t('working')}
      onClick={() =>
        signOut.mutate(undefined, { onSuccess: () => void navigate({ to: '/auth/sign-in' }) })
      }
    >
      {t('signOut')}
    </Button>
  );
}

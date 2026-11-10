import { Spinner } from '@qm/ui';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { INVITE_PATH } from '../../features/auth/next.ts';
import {
  adoptSessionFromFragment,
  useAcceptInvitation,
  useSession,
} from '../../features/auth/api.ts';
import { AuthCard } from '../../features/auth/AuthForm.tsx';
import { SignOutButton } from '../../features/auth/SignOutButton.tsx';

// Emailed staff invitations land here (see supabase/functions/invite-staff). The invitee is signed
// in by the Auth link in the same email, or signs in first and comes back; then the token is
// redeemed and they go to /staff.
export const Route = createFileRoute('/auth/accept-invite')({
  validateSearch: (search): { token?: string } =>
    typeof search.token === 'string' ? { token: search.token } : {},
  component: AcceptInvitePage,
});

function AcceptInvitePage() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const { token } = Route.useSearch();
  const session = useSession();
  const accept = useAcceptInvitation();
  const started = useRef(false);
  // The Auth link puts the session in the URL fragment. 'pending' while it is adopted; "no
  // session yet" is not "signed out" until that is over (and only if it did not give one).
  const [adopted, setAdopted] = useState<'pending' | 'yes' | 'no'>(() =>
    window.location.hash.includes('access_token') ? 'pending' : 'no',
  );
  useEffect(() => {
    if (adopted === 'pending') {
      void adoptSessionFromFragment().then((ok) => setAdopted(ok ? 'yes' : 'no'));
    }
  }, [adopted]);
  const signedIn = Boolean(session.data);

  useEffect(() => {
    if (!token || !signedIn || started.current) return;
    started.current = true;
    accept.mutate(token, {
      // The token is single use; don't leave it in history.
      onSuccess: () => void navigate({ to: '/staff', replace: true }),
    });
  }, [token, signedIn, accept, navigate]);

  // Signed out once the session has loaded: sign in, then return here with the same token.
  useEffect(() => {
    if (token && adopted === 'no' && session.isSuccess && !session.data) {
      void navigate({
        to: '/auth/sign-in',
        search: { next: `${INVITE_PATH}?token=${encodeURIComponent(token)}` },
        replace: true,
      });
    }
  }, [token, adopted, session.isSuccess, session.data, navigate]);

  if (token && accept.error?.message === 'plan_limit_reached') {
    return (
      <AuthCard title={t('invite.fullTitle')} error={t('invite.full')}>
        <p>{t('invite.fullHelp')}</p>
        <div className="flex flex-wrap gap-3">
          <SignOutButton />
        </div>
      </AuthCard>
    );
  }
  if (!token || accept.isError) {
    return (
      <AuthCard title={t('invite.failedTitle')} error={t('invite.invalid')}>
        <p>{t('invite.invalidHelp')}</p>
        <div className="flex flex-wrap gap-3">
          <SignOutButton />
          <Link to="/staff" className="inline-flex min-h-target items-center font-medium underline">
            {t('invite.toConsole')}
          </Link>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('invite.title')}>
      <Spinner label={t('working')} />
    </AuthCard>
  );
}

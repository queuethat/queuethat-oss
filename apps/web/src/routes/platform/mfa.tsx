import { Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useTranslation } from '../../lib/translation.tsx';
import { AuthCard } from '../../features/auth/AuthForm.tsx';
import { mfaStatusQuery } from '../../features/auth/mfa/api.ts';
import { MfaChallenge } from '../../features/auth/mfa/MfaChallenge.tsx';
import { MfaEnrol } from '../../features/auth/mfa/MfaEnrol.tsx';
import { MfaUnenrol } from '../../features/auth/mfa/MfaUnenrol.tsx';

// PLT11 (#417): where a platform operator reaches aal2. Any signed-in account may set up its app
// here (the /platform layout skips its role check for this page), because `pnpm platform:grant`
// only grants a role to an account that already has one: a role holder without a factor would
// let whoever enrols first with their password in. The layout sends aal1 operators here.
export const Route = createFileRoute('/platform/mfa')({
  validateSearch: (search): { next?: string } =>
    typeof search.next === 'string' ? { next: search.next } : {},
  component: MfaPage,
});

function MfaPage() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const status = useQuery(mfaStatusQuery);
  // `next` is only ever a /platform path (the console's guard sets it); anything else stays here.
  const done = () => {
    if (next && /^\/platform([/?#]|$)/.test(next) && !next.startsWith('/platform/mfa')) {
      void navigate({ href: next });
    }
  };

  return (
    <>
      {!status.data ? (
        <Spinner label={t('working')} />
      ) : status.data.level === 'aal2' && status.data.factorId ? (
        <AuthCard title={t('mfa.verified.title')}>
          <p role="status">{t('mfa.verified.body')}</p>
          <MfaUnenrol factorId={status.data.factorId} />
        </AuthCard>
      ) : status.data.factorId ? (
        <AuthCard title={t('mfa.challenge.title')}>
          <p>{t('mfa.challenge.intro')}</p>
          <MfaChallenge factorId={status.data.factorId} onVerified={done} />
        </AuthCard>
      ) : (
        <AuthCard title={t('mfa.enrol.title')}>
          <MfaEnrol onVerified={done} />
        </AuthCard>
      )}
    </>
  );
}

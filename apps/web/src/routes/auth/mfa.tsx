import { Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useTranslation } from '../../lib/translation.tsx';
import { AuthCard } from '../../features/auth/AuthForm.tsx';
import { mfaStatusQuery } from '../../features/auth/mfa/api.ts';
import { MfaChallenge } from '../../features/auth/mfa/MfaChallenge.tsx';
import { safeNext } from '../../features/auth/next.ts';

// 2P-SEC2 (#206): the code step between sign-in and /staff or /admin for an account with an
// authenticator app. The guard on those routes sends aal1 sessions here; `next` is where they were going.
export const Route = createFileRoute('/auth/mfa')({
  validateSearch: (search): { next?: string } =>
    typeof search.next === 'string' ? { next: search.next } : {},
  beforeLoad: async (args) => {
    const { requireSession } = await import('../../features/auth/guard.ts');
    await requireSession(args);
  },
  component: MfaStep,
});

function MfaStep() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const next = safeNext(Route.useSearch().next);
  const status = useQuery(mfaStatusQuery);
  if (!status.data) return <Spinner label={t('working')} />;
  const done = () => void navigate({ href: next });
  if (!status.data.factorId || status.data.level === 'aal2') {
    // Nothing to check (no factor, or already verified): carry on.
    queueMicrotask(done);
    return <Spinner label={t('working')} />;
  }
  return (
    <AuthCard title={t('mfa.challenge.title')}>
      <p>{t('mfa.challenge.intro')}</p>
      <MfaChallenge factorId={status.data.factorId} onVerified={done} />
    </AuthCard>
  );
}

import { Button, Card, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { RequireMfaToggle } from '../../admin/settings/RequireMfaToggle.tsx';
import { useCurrentOrg } from '../current.ts';
import { mfaStatusQuery } from './api.ts';
import { MfaChallenge } from './MfaChallenge.tsx';
import { MfaEnrol } from './MfaEnrol.tsx';
import { MfaUnenrol } from './MfaUnenrol.tsx';

/**
 * `/admin/account/security` (2P-SEC2, #206): add or remove authenticator apps and, for owners,
 * require them for the business's owners and admins.
 */
export function SecurityPage() {
  const { t } = useTranslation('auth');
  const org = useCurrentOrg();
  const status = useQuery(mfaStatusQuery);
  const [adding, setAdding] = useState(false);
  if (!status.data || !org) return <Spinner label={t('working')} />;
  const { level, factors, factorId } = status.data;
  return (
    <Card className="mx-auto mt-8 flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('security.title')}</h1>
      <section className="flex flex-col gap-4" aria-labelledby="mfa-apps">
        <h2 id="mfa-apps" className="text-xl font-semibold">
          {t('security.apps.title')}
        </h2>
        {factors.length === 0 ? (
          <MfaEnrol onVerified={() => undefined} />
        ) : level !== 'aal2' && factorId ? (
          <>
            <p>{t('mfa.challenge.intro')}</p>
            <MfaChallenge factorId={factorId} onVerified={() => undefined} />
          </>
        ) : (
          <>
            <ul className="flex flex-col gap-4" data-testid="mfa-factors">
              {factors.map((factor, index) => (
                <li key={factor.id} className="flex flex-col gap-2">
                  <strong>{t('security.apps.item', { n: index + 1 })}</strong>
                  <MfaUnenrol factorId={factor.id} />
                </li>
              ))}
            </ul>
            {factors.length < 2 ? <p>{t('security.apps.two')}</p> : null}
            {adding ? (
              <MfaEnrol onVerified={() => setAdding(false)} />
            ) : (
              <Button variant="secondary" onClick={() => setAdding(true)}>
                {t('security.apps.add')}
              </Button>
            )}
          </>
        )}
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="mfa-org">
        <h2 id="mfa-org" className="text-xl font-semibold">
          {t('security.org.title')}
        </h2>
        <RequireMfaToggle orgId={org.id} isOwner={org.role === 'owner'} />
      </section>
    </Card>
  );
}

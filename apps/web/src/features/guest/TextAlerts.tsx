import type { ConsentBusiness } from '@qm/domain';
import { Button } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { consentFailed, useGrantTextConsent } from './consent.ts';
import { ConsentOptIn } from './ConsentOptIn.tsx';

/**
 * "Get a text when it's your turn" on the status page, for a guest with a number and no consent
 * (the database says so with `text_consent = 'off'`). After a join whose consent call failed it
 * also says the join worked and texts are off, with the same retry.
 */
export function TextAlerts({
  token,
  business,
  locale,
}: {
  token: string;
  business: ConsentBusiness;
  locale: string;
}) {
  const { t } = useTranslation('guest');
  const grant = useGrantTextConsent(token);
  const [ticked, setTicked] = useState(false);
  return (
    <section aria-labelledby="text-alerts" className="flex flex-col gap-3">
      <h2 id="text-alerts" className="text-lg font-semibold">
        {t('status.textAlerts.title')}
      </h2>
      {consentFailed(token) ? <p role="status">{t('status.textAlerts.failed')}</p> : null}
      <ConsentOptIn business={business} locale={locale} checked={ticked} onChange={setTicked} />
      {grant.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('status.textAlerts.error')}
        </p>
      ) : null}
      <Button
        variant="secondary"
        className="min-h-target-big w-full"
        disabled={!ticked}
        loading={grant.isPending}
        loadingLabel={t('status.textAlerts.turningOn')}
        onClick={() => grant.mutate({ business, locale })}
      >
        {t('status.textAlerts.turnOn')}
      </Button>
    </section>
  );
}

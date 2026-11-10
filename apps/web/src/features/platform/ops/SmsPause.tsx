import { Button, Input, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { opsError, smsHealthQuery, useSetSmsPause } from './api.ts';

/**
 * Platform SMS health on the org detail (#1155): whether the business's texts through the shared
 * QueueThat number are paused (by the 5-minute job or an operator), its last-24h
 * counts, and for operators a reason-required pause or resume. The database decides and audits.
 */
export function SmsPause({ orgId, canAct }: { orgId: string; canAct: boolean }) {
  const { t } = useTranslation('platform');
  const health = useQuery(smsHealthQuery(orgId));
  const set = useSetSmsPause(orgId);
  const [reason, setReason] = useState('');

  if (!health.data) {
    return health.isError ? (
      <p role="alert">{t('ops.loadFailed')}</p>
    ) : (
      <Spinner label={t('ops.loading')} />
    );
  }
  const { state, stats_24h: stats } = health.data;
  const paused = state === 'auto' || state === 'manual';
  const why = (health.data.reason ?? '').trim();
  const status = !state
    ? t('ops.smsPause.running')
    : t(`ops.smsPause.${state}`, {
        reason: state === 'auto' ? t(`ops.smsPause.reasons.${why}`, { defaultValue: why }) : why,
      });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim() !== '')
      set.mutate({ pause: !paused, reason }, { onSuccess: () => setReason('') });
  };

  return (
    <section aria-labelledby="sms-pause" className="flex flex-col gap-4">
      <h2 id="sms-pause" className="text-xl font-semibold">
        {t('ops.smsPause.title')}
      </h2>
      {health.data.platform_mode ? (
        <>
          <p data-testid="sms-pause-status">{status}</p>
          <p>{t('ops.smsPause.stats', stats)}</p>
          {canAct ? (
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <Input
                label={t('ops.smsPause.reason')}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
              {set.error ? (
                <p role="alert">{t(`ops.smsPause.errors.${opsError(set.error)}`)}</p>
              ) : null}
              <Button
                type="submit"
                variant={paused ? 'primary' : 'secondary'}
                loading={set.isPending}
                loadingLabel={t('ops.saving')}
              >
                {paused ? t('ops.smsPause.resume') : t('ops.smsPause.pause')}
              </Button>
            </form>
          ) : null}
        </>
      ) : (
        <p>{t('ops.smsPause.notPlatform')}</p>
      )}
    </section>
  );
}

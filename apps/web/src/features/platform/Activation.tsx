import { Badge, Card, type Tone } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import type { Activation } from './api.ts';
import { formatWhen } from './format.ts';

/** How a tenant's activation reads in the directory; the database already decided `is_stuck`. */
export function activationBadge(a: Activation): {
  key: 'done' | 'stuck' | 'suspended' | 'onTrack';
  tone: Tone;
} {
  if (a.stage === 'first_served') return { key: 'done', tone: 'success' };
  if (a.org_status !== 'active') return { key: 'suspended', tone: 'neutral' };
  return a.is_stuck ? { key: 'stuck', tone: 'warning' } : { key: 'onTrack', tone: 'info' };
}

/** The directory cell: a badge and, for a stuck tenant, the stage it stopped at and for how long. */
export function ActivationBadge({ activation }: { activation: Activation | undefined }) {
  const { t } = useTranslation('platform');
  if (!activation) return <span aria-hidden="true">–</span>;
  const { key, tone } = activationBadge(activation);
  return (
    <div className="flex flex-col gap-1">
      <Badge tone={tone}>{t(`funnel.badge.${key}`)}</Badge>
      {key === 'stuck' ? (
        <span className="text-sm text-muted">
          {t(`funnel.stage.${activation.stage}`)} ·{' '}
          {t('funnel.detail.stuck', { count: activation.stuck_days ?? 0 })}
        </span>
      ) : null}
    </div>
  );
}

/** One tenant's stages, each with when it was reached, and how long it has been stuck. */
export function ActivationSection({ activation }: { activation: Activation }) {
  const { t, i18n } = useTranslation('platform');
  const { key } = activationBadge(activation);
  return (
    <Card className="flex flex-col gap-3" data-testid="activation">
      <h2 className="text-xl font-semibold">{t('funnel.detail.title')}</h2>
      <p>
        {key === 'done'
          ? t('funnel.detail.done')
          : key === 'suspended'
            ? t('funnel.detail.suspended')
            : activation.is_stuck
              ? t('funnel.detail.stuck', { count: activation.stuck_days ?? 0 })
              : t('funnel.detail.furthest', { stage: t(`funnel.stage.${activation.stage}`) })}
      </p>
      <ol className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        {activation.stages.map((s) => (
          <li key={s.stage} className="contents" data-reached={s.reached_at ? 'yes' : 'no'}>
            <span>{t(`funnel.stage.${s.stage}`)}</span>
            <span className="text-muted">
              {formatWhen(s.reached_at, i18n.language, t('funnel.detail.notReached'))}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

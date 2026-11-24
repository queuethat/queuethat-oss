import { errorCode } from '@qm/domain';
import { useTranslation } from '../../lib/translation.tsx';
import { ExtensionSlot } from '../../extensions/ExtensionSlot.tsx';
import type { ExtensionSlotProps } from '../../extensions/types.ts';

type Feature = ExtensionSlotProps['feature.gated']['feature'];

/**
 * True when the database refused a create because the org's plan does not include the feature
 * (`feature_not_in_plan`). Screens show `PlanGateNotice` instead of their generic error text.
 */
export function isFeatureGated(error: unknown): boolean {
  return errorCode(error) === 'feature_not_in_plan';
}

/**
 * Tells the person their plan does not include what they tried to add, and that what they already
 * have keeps working. A deployment's `feature.gated` slot replaces the text, for example with a link
 * to an upgrade page. The database owns the rule; this only renders the refusal.
 */
export function PlanGateNotice({ feature, limit }: { feature: Feature; limit?: number }) {
  const { t } = useTranslation('common');
  const reason =
    feature === 'queues'
      ? limit === undefined
        ? t('plan.queuesNoCount')
        : t('plan.queues', { count: limit })
      : t(`plan.${feature}`);
  return (
    <ExtensionSlot name="feature.gated" props={{ feature, limit }}>
      <p role="alert" className="font-medium text-danger-strong">
        {reason} {t('plan.existing')}
      </p>
    </ExtensionSlot>
  );
}

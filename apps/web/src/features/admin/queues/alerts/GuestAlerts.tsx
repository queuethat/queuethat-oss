import { renderTemplate, SAMPLE_TEMPLATE_VARS } from '@qm/domain';
import { Checkbox, Input } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentOrg } from '../../../auth/current.ts';
import { templatesQuery } from '../../templates/api.ts';
import { ALERT_TRIGGERS, type AlertTrigger } from '../api.ts';

/**
 * The "Guest alerts" part of the queue form (N-8, #133): which alerts guests of this queue can
 * get, each with the system's default push wording as an example, and the almost-up distance.
 * Wording itself is edited under Templates.
 */
export function GuestAlerts({
  triggers,
  threshold,
  onTriggers,
  onThreshold,
}: {
  triggers: AlertTrigger[];
  threshold: number;
  onTriggers: (next: AlertTrigger[]) => void;
  onThreshold: (next: number) => void;
}) {
  const { t } = useTranslation('admin');
  const org = useCurrentOrg();
  const templates = useQuery({ ...templatesQuery(org?.id ?? ''), enabled: !!org });
  const example = (trigger: AlertTrigger) => {
    const row = templates.data?.find(
      (r) => r.orgId === null && r.trigger === trigger && r.medium === 'push',
    );
    return row ? renderTemplate(row.body, SAMPLE_TEMPLATE_VARS) : undefined;
  };
  return (
    <fieldset className="flex flex-col gap-4 rounded-control border border-border p-4">
      <legend className="px-1 font-semibold">{t('queues.alerts.title')}</legend>
      <p className="text-muted">{t('queues.alerts.intro')}</p>
      {ALERT_TRIGGERS.map((trigger) => {
        const sample = example(trigger);
        return (
          <Checkbox
            key={trigger}
            label={t(`queues.alerts.trigger.${trigger}`)}
            hint={[
              sample ? t('queues.alerts.example', { text: sample }) : null,
              trigger === 'joined' ? t('queues.alerts.joinedHint') : null,
            ]
              .filter(Boolean)
              .join(' ')}
            checked={triggers.includes(trigger)}
            onChange={(event) =>
              onTriggers(
                event.target.checked
                  ? ALERT_TRIGGERS.filter((x) => x === trigger || triggers.includes(x))
                  : triggers.filter((x) => x !== trigger),
              )
            }
          />
        );
      })}
      <Input
        label={t('queues.alerts.threshold')}
        hint={t('queues.alerts.thresholdHint')}
        type="number"
        inputMode="numeric"
        required
        min={1}
        max={20}
        value={String(threshold)}
        onChange={(event) => onThreshold(Number(event.target.value))}
      />
    </fieldset>
  );
}

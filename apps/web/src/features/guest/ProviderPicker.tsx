import type { Database } from '@qm/db-types';
import { formatEta, type Translate } from '@qm/domain';
import { RadioGroup, type ChoiceOption } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import type { NotAcceptingReason } from './joinErrors.ts';

type PublicLine = Database['api']['CompositeTypes']['public_line'];

/**
 * Who the guest wants to see (M5): one choice per line the database lists, "Anyone available" first.
 * Choosing a line only picks the queue; the service and the form that follow are the ones of that
 * line. Every state shown here (accepting, wait) is the database's answer, never worked out here.
 */
export function ProviderPicker({
  lines,
  value,
  onChange,
}: {
  lines: readonly PublicLine[];
  value: string;
  onChange: (queueId: string) => void;
}) {
  const { t, i18n } = useTranslation('guest');
  const eta = i18n.getFixedT(null, 'eta') as Translate;
  const options: ChoiceOption[] = lines.map((line) => {
    const wait = [
      formatEta(line.eta_state, line.eta_low, line.eta_high, eta),
      t('join.wait.waiting', { count: line.waiting_count ?? 0 }),
    ]
      .filter(Boolean)
      .join(', ');
    return {
      value: line.queue_id ?? '',
      label: line.kind === 'pool' ? t('join.lines.anyone') : (line.name ?? ''),
      hint: line.accepting
        ? line.kind === 'pool'
          ? `${t('join.lines.anyoneHint')} ${wait}`
          : wait
        : t(`join.notAccepting.${(line.not_accepting_reason ?? 'closed') as NotAcceptingReason}`),
      disabled: !line.accepting,
    };
  });
  return (
    <RadioGroup label={t('join.lines.title')} options={options} value={value} onChange={onChange} />
  );
}

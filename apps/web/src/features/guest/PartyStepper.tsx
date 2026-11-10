import { BigButton } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';

/**
 * How many people the visit is for, between the queue's bounds (2A-Q9). Loaded on demand so the
 * join page stays inside its bundle budget; it renders only when the queue asks for a party size.
 */
export default function PartyStepper({
  min,
  max,
  value,
  onChange,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation('guest');
  return (
    <div role="group" aria-labelledby="party-label" className="flex flex-col gap-2">
      <span id="party-label" className="font-medium">
        {t('join.party')}
      </span>
      <div className="flex items-center gap-3">
        <BigButton
          type="button"
          variant="secondary"
          className="w-auto"
          aria-label={t('join.partyFewer')}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          −
        </BigButton>
        <output
          aria-live="polite"
          aria-label={t('join.partySize', { count: value })}
          className="min-w-12 text-center text-2xl font-semibold"
        >
          {value}
        </output>
        <BigButton
          type="button"
          variant="secondary"
          className="w-auto"
          aria-label={t('join.partyMore')}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
        >
          +
        </BigButton>
      </div>
    </div>
  );
}

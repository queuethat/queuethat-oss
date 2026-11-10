import { useTranslation } from '../../lib/translation.tsx';
import { useNow } from '../../lib/now.ts';
import type { OnsiteCode } from './api.ts';

const RADIUS = 28;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The corner panel with the code guests type to join from their phone, readable across a room,
 * with a ring that empties as the code approaches its change.
 */
export function OnsiteCodePanel({ onsite }: { onsite: OnsiteCode }) {
  const { t } = useTranslation('display');
  const now = useNow(1_000);
  const left = Math.max(0, onsite.validUntilMs - now);
  const fraction = Math.min(1, left / onsite.windowMs);

  return (
    <aside
      data-testid="onsite-code"
      className="fixed bottom-6 right-6 flex items-center gap-6 rounded-card border border-border bg-surface px-8 py-5 shadow-lg"
    >
      <div>
        <p className="text-2xl font-semibold text-muted">{t('onsite.label')}</p>
        <p
          aria-label={onsite.code.split('').join(' ')}
          className="text-display font-bold tabular-nums tracking-widest"
        >
          {onsite.code}
        </p>
        <p className="text-xl text-muted">{t('onsite.hint')}</p>
      </div>
      {/* eslint-disable-next-line no-restricted-syntax -- data-driven drawing, not an icon */}
      <svg
        viewBox="0 0 64 64"
        className="size-20 -rotate-90"
        role="img"
        aria-label={t('onsite.countdown', { seconds: Math.ceil(left / 1000) })}
      >
        <circle cx="32" cy="32" r={RADIUS} fill="none" strokeWidth="6" className="stroke-border" />
        <circle
          cx="32"
          cy="32"
          r={RADIUS}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          className="stroke-primary"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
        />
      </svg>
    </aside>
  );
}

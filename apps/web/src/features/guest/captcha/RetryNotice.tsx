import { useEffect, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';

/**
 * "Too many tries from this network, try again in N minutes", counted down to the timestamp
 * `until` (ms) and announced by the live region (polite: the wording changes once a minute, not
 * every second). `onDone` fires when the wait is over so the form can enable Join again.
 */
export function RetryNotice({ until, onDone }: { until: number; onDone: () => void }) {
  const { t } = useTranslation('guest');
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((until - now) / 1000));

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (left === 0) onDone();
  }, [left, onDone]);

  if (left === 0) return null;
  return (
    <p role="status" aria-live="polite" className="font-medium text-danger-strong">
      {t('join.retryIn', { count: Math.ceil(left / 60) })}
    </p>
  );
}

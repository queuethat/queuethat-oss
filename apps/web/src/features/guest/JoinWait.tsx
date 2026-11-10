import { formatEta, type Translate } from '@qm/domain';
import { Card } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { OpenPill } from './JoinState.tsx';
import { formatAsOf, isStale } from '../../lib/live.ts';
import { useNow } from '../../lib/now.ts';
import { localWhen } from './hours.ts';
import type { Database } from '@qm/db-types';

type PublicWait = Database['api']['CompositeTypes']['public_wait'];

function openingLabel(opensAt: string, now: number, tz: string, locale: string, t: Translate) {
  const { time, day } = localWhen(opensAt, now, tz, locale);
  return day ? t('join.wait.opensLater', { day, time }) : t('join.wait.opensToday', { time });
}

/**
 * The picked queue's wait on the join page (G-14): "About 20–30 min, 4 waiting", the database's
 * degradation wording, or when the location is closed by its hours when it opens. Numbers are
 * rendered as given and never counted down; once the data is over two minutes old they grey
 * out with "as of".
 */
export function JoinWait({
  wait,
  tz,
  updatedAt,
}: {
  wait: PublicWait | undefined;
  tz: string;
  updatedAt: number;
}) {
  const { t, i18n } = useTranslation('guest');
  const now = useNow(15_000);
  if (!wait) return null;
  const stale = isStale(updatedAt, now);
  const eta = formatEta(
    wait.eta_state,
    wait.eta_low,
    wait.eta_high,
    i18n.getFixedT(null, 'eta') as Translate,
  );
  const opens = wait.opens_next_at
    ? openingLabel(wait.opens_next_at, now, tz, i18n.language, t as Translate)
    : null;
  // Paused or full with no opening time: the notice above the form says why, not a wait.
  if (!wait.accepting && !opens) return null;
  const waiting = t('join.wait.waiting', { count: wait.waiting_count ?? 0 });
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p
          data-testid="join-wait"
          className={`text-lg font-semibold tracking-tight ${stale ? 'text-muted opacity-60' : ''}`.trim()}
        >
          {opens ?? [eta, waiting].filter(Boolean).join(', ')}
        </p>
        {wait.accepting && !opens ? <OpenPill /> : null}
      </div>
      {stale && wait.as_of ? (
        <p className="text-sm text-muted">
          {t('join.wait.asOf', { time: formatAsOf(wait.as_of, i18n.language, tz) })}
        </p>
      ) : null}
    </Card>
  );
}

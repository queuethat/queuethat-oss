import { Spinner, StatusPill, TicketNumber } from '@qm/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useConnectionState } from '../../../lib/live.ts';
import { HIGHLIGHT_MS } from '../highlight.ts';
import type { CounterSnapshot } from './api.ts';

/**
 * A small screen above a desk, readable from 3 m: the counter's label and the ticket being
 * served, huge. Separate from data fetching so it renders in unit tests. `unbound` is a display
 * no admin has assigned to a counter yet.
 */
export function CounterView({
  snapshot,
  failed,
  unbound,
}: {
  snapshot?: CounterSnapshot | null;
  failed?: boolean;
  unbound?: boolean;
}) {
  const { t } = useTranslation('display');
  const connection = useConnectionState();
  const highlighted = useNewCall(snapshot?.ticket ?? null, !!snapshot);

  if (unbound)
    return (
      <p role="alert" className="text-4xl">
        {t('counter.unbound')}
      </p>
    );
  if (!snapshot) {
    return failed ? (
      <p role="alert" className="text-4xl">
        {t('board.error')}
      </p>
    ) : (
      <Spinner label={t('pair.loading')} />
    );
  }
  const closed = snapshot.status === 'closed';
  return (
    <section
      aria-labelledby="counter-label"
      data-highlight={highlighted ? 'true' : 'false'}
      className={`flex min-h-[80vh] flex-col items-center justify-center gap-8 rounded-card p-8 text-center ${
        highlighted
          ? 'bg-state-called-soft text-state-called-strong ring-8 ring-state-called-edge'
          : ''
      }`}
    >
      {connection !== 'live' ? (
        <p
          role="status"
          data-testid="reconnecting"
          className="rounded-card bg-warning-soft px-6 py-4 text-2xl font-semibold text-warning-strong"
        >
          {t('board.reconnecting')}
        </p>
      ) : null}
      {highlighted ? <StatusPill status="called">{t('board.called')}</StatusPill> : null}
      <h1 id="counter-label" className="text-6xl font-semibold">
        {snapshot.counter_label}
      </h1>
      {closed ? (
        <p data-testid="counter-closed" className="text-display font-bold">
          {t('counter.closed')}
        </p>
      ) : snapshot.ticket ? (
        <>
          <p className="text-2xl text-muted">{t('counter.nowServing')}</p>
          <p data-testid="counter-ticket">
            <TicketNumber ticket={snapshot.ticket} size="counter" />
          </p>
          {snapshot.guest_first_name ? (
            <p className="text-5xl">{snapshot.guest_first_name}</p>
          ) : null}
        </>
      ) : (
        <p data-testid="counter-idle" className="text-6xl text-muted">
          {t('counter.idle')}
        </p>
      )}
    </section>
  );
}

/**
 * True for HIGHLIGHT_MS after a different ticket appears on screen. The first data never flashes,
 * so a reload isn't a call. A recall of the same ticket is not flagged: the snapshot carries no
 * call time (the TV board does), and the ticket on screen is already the right one.
 */
function useNewCall(ticket: string | null, ready: boolean) {
  const seen = useRef<string | null | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const previous = seen.current;
    seen.current = ticket;
    if (previous === undefined || ticket === null || ticket === previous) return;
    window.clearTimeout(timer.current);
    setOn(true);
    timer.current = window.setTimeout(() => setOn(false), HIGHLIGHT_MS);
  }, [ticket, ready]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return on;
}

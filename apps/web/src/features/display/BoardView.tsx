import { Badge, Spinner, StatusPill, TicketNumber } from '@qm/ui';
import type { Database } from '@qm/db-types';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { formatAsOf, useConnectionState } from '../../lib/live.ts';
import { useNow } from '../../lib/now.ts';
import { HIGHLIGHT_MS, callKey, newCalls } from './highlight.ts';
import type { CallNotice } from './signage/SlidePanel.tsx';

type Snapshot = Database['api']['CompositeTypes']['display_snapshot'];
type Queue = Database['api']['CompositeTypes']['display_queue'];
type Ticket = Database['api']['CompositeTypes']['display_ticket'];

/**
 * The TV board for one snapshot. Separate from data fetching so it renders in unit tests. The
 * "updated" time shows in the location's `timeZone` (I-6), and only once that is known.
 */
export function BoardView({
  snapshot,
  failed,
  timeZone,
  panel,
}: {
  snapshot?: Snapshot | null;
  failed?: boolean;
  timeZone?: string;
  /** Rendered below the queues with the calls being highlighted now (the signage panel, 4-SIG2). */
  panel?: (calls: CallNotice[]) => ReactNode;
}) {
  const { t, i18n } = useTranslation('display');
  const connection = useConnectionState();
  const highlighted = useHighlights(snapshot);

  return (
    <section className="space-y-8">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-display font-bold">{t('nowServing.title')}</h1>
        {snapshot?.location_name ? (
          <p className="text-4xl text-muted">{snapshot.location_name}</p>
        ) : null}
      </header>
      {connection !== 'live' ? (
        <p
          role="status"
          data-testid="reconnecting"
          className="rounded-card bg-warning-soft px-6 py-4 font-semibold text-warning-strong"
        >
          {t('board.reconnecting')}
        </p>
      ) : null}
      {!snapshot ? (
        failed ? (
          <p role="alert">{t('board.error')}</p>
        ) : (
          <Spinner label={t('pair.loading')} />
        )
      ) : (
        <>
          <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-3">
            {(snapshot.queues ?? []).map((queue) => (
              <QueueBoard
                key={queue.id}
                queue={queue}
                namesEnabled={!!snapshot.names_enabled}
                highlighted={highlighted}
              />
            ))}
          </div>
          {panel
            ? panel(
                (snapshot.queues ?? [])
                  .flatMap((q) => q.now_serving ?? [])
                  .filter((ticket) => highlighted.has(callKey(ticket)))
                  .map((ticket) => ({
                    ticket: ticket.display_ticket ?? '',
                    counter: ticket.counter_label,
                  })),
              )
            : null}
          {snapshot.as_of && timeZone ? (
            <p className="text-xl text-muted">
              {t('board.asOf', { time: formatAsOf(snapshot.as_of, i18n.language, timeZone) })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function QueueBoard({
  queue,
  namesEnabled,
  highlighted,
}: {
  queue: Queue;
  namesEnabled: boolean;
  highlighted: ReadonlySet<string>;
}) {
  const { t } = useTranslation('display');
  const headingId = `queue-${queue.id}`;
  const serving = queue.now_serving ?? [];
  const next = queue.next_up ?? [];
  const name = (ticket: Ticket) => (namesEnabled ? ticket.first_name : null);

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-6 rounded-card border border-border bg-surface p-6"
    >
      <header className="flex items-center justify-between gap-4">
        <h2 id={headingId} className="text-4xl font-semibold">
          {queue.name}
        </h2>
        {queue.state && queue.state !== 'open' ? (
          <Badge tone="warning" className="text-2xl">
            {t(`board.state.${queue.state}`)}
          </Badge>
        ) : null}
      </header>

      <ul data-testid="now-serving" className="space-y-3">
        {serving.length === 0 ? (
          <li className="text-3xl text-muted">{t('board.noneCalled')}</li>
        ) : (
          serving.map((ticket) => {
            const key = callKey(ticket);
            const isNew = highlighted.has(key);
            return (
              <li
                key={key}
                data-highlight={isNew ? 'true' : 'false'}
                className={
                  isNew
                    ? 'flex flex-wrap items-center gap-x-4 rounded-control bg-state-called-soft px-4 py-2 text-state-called-strong ring-4 ring-state-called-edge'
                    : 'flex flex-wrap items-center gap-x-4 px-4 py-2'
                }
              >
                <TicketNumber ticket={ticket.display_ticket ?? ''} size="board" />
                {/* The ring alone is colour; the pill says it in words and shape. */}
                {isNew ? <StatusPill status="called">{t('board.called')}</StatusPill> : null}
                {ticket.counter_label ? (
                  <span className="text-5xl">
                    <span aria-hidden="true">{t('board.arrow')}</span>{' '}
                    <span className="sr-only">{t('board.atCounter')}</span>
                    {ticket.counter_label}
                  </span>
                ) : null}
                {name(ticket) ? <span className="text-3xl">{name(ticket)}</span> : null}
              </li>
            );
          })
        )}
      </ul>

      <div>
        <h3 className="text-2xl font-semibold text-muted">{t('board.nextUp')}</h3>
        <ol data-testid="next-up" className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-4xl">
          {next.length === 0 ? (
            <li className="text-3xl text-muted">{t('board.noneWaiting')}</li>
          ) : (
            next.map((ticket) => (
              <li key={ticket.display_ticket}>
                <TicketNumber ticket={ticket.display_ticket ?? ''} size="tablet" />
                {name(ticket) ? <span className="ml-2 text-2xl">{name(ticket)}</span> : null}
              </li>
            ))
          )}
        </ol>
      </div>
    </section>
  );
}

/** Calls that arrived since the board first had data, each kept for HIGHLIGHT_MS. */
function useHighlights(snapshot: Snapshot | null | undefined): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [until, setUntil] = useState<ReadonlyMap<string, number>>(new Map());
  const now = useNow(1_000);

  useEffect(() => {
    if (!snapshot) return;
    const keys = (snapshot.queues ?? []).flatMap((q) => (q.now_serving ?? []).map(callKey));
    const fresh = newCalls(seen.current, keys);
    seen.current = new Set([...(seen.current ?? []), ...keys]);
    if (fresh.length === 0) return;
    const expires = Date.now() + HIGHLIGHT_MS;
    setUntil((prev) => new Map([...prev, ...fresh.map((k) => [k, expires] as const)]));
  }, [snapshot]);

  return new Set([...until].filter(([, expires]) => expires > now).map(([key]) => key));
}

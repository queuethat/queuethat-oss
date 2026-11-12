import { useState } from 'react';
import { Badge, Button, Card } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import type { ConsoleQueue, ConsoleVisit } from '../api.ts';
import { callableCount, hasLines, myLineIds } from './lines.ts';
import type { MyLines } from './api.ts';

const NEXT_SHOWN = 3;
const VIEWS = ['mine', 'all'] as const;

/**
 * M6 (#1293): every line at a location that runs per-person lines, on one screen. A provider
 * starts on "My lines" (their line plus the pool it pulls from); the front desk, or anyone without
 * a line of their own, sees all lines. Call next on a provider line falls back to the pool in the
 * database; this only enables the button when either has someone waiting. Renders nothing for a
 * location without provider or pool lines.
 */
export function LinesBoard({
  queues,
  visits,
  mine,
  currentId,
  mayCall,
  disabled,
  calling,
  onCallNext,
  onOpen,
}: {
  queues: ConsoleQueue[];
  visits: ConsoleVisit[];
  mine: MyLines | undefined;
  currentId: string | undefined;
  mayCall: boolean;
  /** Offline or on a break: Call next waits. */
  disabled: boolean;
  /** The line a Call next is running for, if any. */
  calling: string | null;
  onCallNext: (queueId: string) => void;
  onOpen: (queueId: string) => void;
}) {
  const { t } = useTranslation('staff');
  const own = myLineIds(queues, mine?.queueIds ?? null);
  const [choice, setChoice] = useState<'mine' | 'all' | null>(null);
  if (!hasLines(queues)) return null;
  const view = mine?.restricted || (own.length > 0 && choice !== 'all') ? 'mine' : 'all';
  const shown =
    view === 'mine' && own.length > 0 ? queues.filter((q) => own.includes(q.id)) : queues;

  return (
    <section aria-labelledby="console-lines" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="console-lines" className="text-lg font-semibold">
          {t('console.lines.title')}
        </h2>
        {own.length > 0 && !mine?.restricted ? (
          <div role="group" aria-label={t('console.lines.view')} className="flex gap-2">
            {VIEWS.map((id) => (
              <Button
                key={id}
                variant={view === id ? 'primary' : 'secondary'}
                aria-pressed={view === id}
                onClick={() => setChoice(id)}
              >
                {t(`console.lines.${id}`)}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
        {shown.map((q) => {
          const waiting = visits.filter((v) => v.queueId === q.id && v.status === 'waiting');
          const callable = callableCount(q, visits);
          const pool = q.pullsFrom ? queues.find((p) => p.id === q.pullsFrom) : undefined;
          return (
            <li key={q.id}>
              <Card
                aria-labelledby={`line-${q.id}`}
                data-testid={`line-${q.id}`}
                className={q.id === currentId ? 'border-primary' : undefined}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 id={`line-${q.id}`} className="font-semibold">
                    {q.name}
                  </h3>
                  {q.kind === 'pool' ? <Badge tone="info">{t('console.lines.pool')}</Badge> : null}
                  {mine?.queueIds?.includes(q.id) ? (
                    <Badge tone="success">{t('console.lines.yours')}</Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-sm">
                  {t('console.waitingCount', { count: waiting.length })}
                </p>
                {waiting.length > 0 ? (
                  <ol
                    aria-label={t('console.lines.next', { line: q.name })}
                    className="mt-2 text-sm"
                  >
                    {waiting.slice(0, NEXT_SHOWN).map((v) => (
                      <li key={v.id}>
                        <span className="font-mono font-semibold">{v.ticket}</span>{' '}
                        {v.name ?? t('console.noName')}
                      </li>
                    ))}
                  </ol>
                ) : null}
                {pool && waiting.length === 0 && callable > 0 ? (
                  <p className="mt-2 text-sm">{t('console.lines.fromPool', { pool: pool.name })}</p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {mayCall ? (
                    <Button
                      disabled={callable === 0 || disabled || calling !== null}
                      aria-label={t('console.lines.callNext', { line: q.name })}
                      onClick={() => onCallNext(q.id)}
                    >
                      {calling === q.id ? t('console.calling') : t('console.callNext')}
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    aria-current={q.id === currentId ? 'true' : undefined}
                    aria-label={t('console.lines.open', { line: q.name })}
                    onClick={() => onOpen(q.id)}
                  >
                    {t('console.lines.openShort')}
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

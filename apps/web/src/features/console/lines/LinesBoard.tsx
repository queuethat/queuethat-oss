import { useState } from 'react';
import { Button } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import type { ConsoleQueue } from '../api.ts';
import { hasLines, myLineIds } from './lines.ts';
import type { MyLines } from './api.ts';

const VIEWS = ['mine', 'all'] as const;

/**
 * M6 (#1293): which lines the console's tabs list at a location that runs per-person lines. A
 * provider starts on "My lines" (their line plus the pool it pulls from); the front desk, or
 * anyone without a line of their own, sees all lines. Lines are tabs only, with one Call next for
 * the open tab; Call next on a provider line falls back to the pool in the database.
 */
export function useLineView(queues: ConsoleQueue[], mine: MyLines | undefined) {
  const own = myLineIds(queues, mine?.queueIds ?? null);
  const [choice, setChoice] = useState<'mine' | 'all' | null>(null);
  const view: 'mine' | 'all' =
    mine?.restricted || (own.length > 0 && choice !== 'all') ? 'mine' : 'all';
  const shown =
    hasLines(queues) && view === 'mine' && own.length > 0
      ? queues.filter((q) => own.includes(q.id))
      : queues;
  const canSwitch = hasLines(queues) && own.length > 0 && !mine?.restricted;
  return { shown, view, setChoice: (next: 'mine' | 'all') => setChoice(next), canSwitch };
}

/** The "My lines / All lines" switch; renders nothing when the person has no choice to make. */
export function LinesToggle({
  view,
  canSwitch,
  onChoose,
}: {
  view: 'mine' | 'all';
  canSwitch: boolean;
  onChoose: (view: 'mine' | 'all') => void;
}) {
  const { t } = useTranslation('staff');
  if (!canSwitch) return null;
  return (
    <div role="group" aria-label={t('console.lines.view')} className="flex gap-2">
      {VIEWS.map((id) => (
        <Button
          key={id}
          variant={view === id ? 'primary' : 'secondary'}
          aria-pressed={view === id}
          onClick={() => onChoose(id)}
        >
          {t(`console.lines.${id}`)}
        </Button>
      ))}
    </div>
  );
}

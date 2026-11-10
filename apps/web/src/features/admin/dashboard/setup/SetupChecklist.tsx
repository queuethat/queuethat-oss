import { Button, Card, Icon, iconCheck, LinkButton } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../../lib/translation.tsx';
import type { SetupProgress } from './api.ts';

/** The facts from `api.org_setup_state` the checklist ticks from. */
export interface SetupFacts {
  has_hours: boolean | null;
  has_queue: boolean | null;
  members: number | null;
  pending_invitations: number | null;
  devices: number | null;
}

type Step = 'line' | 'hours' | 'team' | 'screen' | 'poster';
const ROUTES = {
  line: '/admin/queues',
  hours: '/admin/location/hours',
  team: '/admin/team',
  screen: '/admin/devices',
  poster: '/admin/poster',
} as const;

/** Which steps are done. Steps 1 to 4 follow the database; the poster is the member's own tick. */
export function doneSteps(facts: SetupFacts, progress: SetupProgress): Record<Step, boolean> {
  return {
    line: !!facts.has_queue,
    hours: !!facts.has_hours,
    team: (facts.members ?? 0) > 1 || (facts.pending_invitations ?? 0) > 0,
    screen: (facts.devices ?? 0) > 0,
    poster: !!progress.posterPrinted,
  };
}

/**
 * Five first-run steps on Today. Each links to its page; none blocks navigation. The member can
 * tick the poster step by hand and hide the whole list.
 */
export function SetupChecklist({
  facts,
  progress,
  onProgress,
}: {
  facts: SetupFacts;
  progress: SetupProgress;
  onProgress: (patch: SetupProgress) => void;
}) {
  const { t } = useTranslation('admin-setup');
  const done = doneSteps(facts, progress);
  const steps: Step[] = ['line', 'hours', 'team', 'screen', 'poster'];
  const count = steps.filter((s) => done[s]).length;

  return (
    <Card className="flex flex-col gap-4" data-testid="setup-checklist">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted tabular-nums">{t('count', { done: count, total: 5 })}</p>
      </div>
      <div
        role="progressbar"
        aria-label={t('title')}
        aria-valuemin={0}
        aria-valuemax={5}
        aria-valuenow={count}
        className="h-2 overflow-hidden rounded-full bg-border"
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${(count / 5) * 100}%` }}
        />
      </div>
      <ul>
        {steps.map((step) => (
          <li
            key={step}
            data-done={done[step]}
            className="flex flex-wrap items-center gap-3 border-t border-border py-3"
          >
            <span
              aria-hidden="true"
              className={
                done[step]
                  ? 'grid size-7 shrink-0 place-items-center rounded-full bg-primary text-on-primary'
                  : 'size-7 shrink-0 rounded-full border-2 border-border'
              }
            >
              {done[step] ? <Icon icon={iconCheck} size="sm" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <p className={done[step] ? 'font-semibold text-muted' : 'font-semibold'}>
                {t(`steps.${step}.title`)}
                {done[step] ? <span className="sr-only"> {t('doneLabel')}</span> : null}
              </p>
              <p className="text-sm text-muted">{t(`steps.${step}.hint`)}</p>
            </div>
            {done[step] ? null : (
              <div className="flex flex-wrap gap-2">
                <LinkButton variant="secondary" render={(p) => <Link to={ROUTES[step]} {...p} />}>
                  {t(`steps.${step}.action`)}
                </LinkButton>
                {step === 'poster' ? (
                  <Button variant="secondary" onClick={() => onProgress({ posterPrinted: true })}>
                    {t('steps.poster.markDone')}
                  </Button>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={() => onProgress({ dismissed: true })}>
          {t('hide')}
        </Button>
      </div>
    </Card>
  );
}

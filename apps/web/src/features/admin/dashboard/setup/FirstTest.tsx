import { Button, Card, Icon, iconCheck, LinkButton } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../../auth/current.ts';
import { publicJoinUrl } from '../../poster/url.ts';
import { useFirstTestFacts, useSetupProgress, type FirstTestFacts } from './api.ts';

type Step = 'open' | 'join' | 'call';
const STEPS: Step[] = ['open', 'join', 'call'];

/** Which steps are done. Opening the link has no trace, so a visit existing also proves it. */
export function firstTestDone(facts: FirstTestFacts, opened: boolean): Record<Step, boolean> {
  return { open: opened || facts.joined, join: facts.joined, call: facts.called };
}

/**
 * The guided first test (#68): open the join link, join, call yourself from the console. Steps
 * tick from the org's visits, live. Managers only; hidden once the owner dismisses it or any
 * visit has been served. Display only: joining and calling happen on their own screens.
 */
export function FirstTest() {
  const { t } = useTranslation('admin-setup');
  const org = useCurrentOrg();
  const { location } = useCurrentLocation();
  const { progress, update } = useSetupProgress(location?.id);
  const isManager = org?.role === 'owner' || org?.role === 'admin' || org?.role === 'manager';
  const facts = useFirstTestFacts(isManager ? org?.id : undefined, location?.id).data;
  const [opened, setOpened] = useState(false);
  if (!isManager || !location || !facts || facts.served || progress.firstTestDismissed) return null;

  const done = firstTestDone(facts, opened);
  const all = STEPS.every((s) => done[s]);
  const url = publicJoinUrl(location.slug);

  return (
    <Card className="flex flex-col gap-3" data-testid="first-test">
      <div>
        <h2 className="text-xl font-semibold">
          {t(all ? 'firstTest.doneTitle' : 'firstTest.title')}
        </h2>
        <p className="text-sm text-muted">{t(all ? 'firstTest.doneIntro' : 'firstTest.intro')}</p>
      </div>
      <ol>
        {STEPS.map((step) => (
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
                {t(`firstTest.steps.${step}.title`)}
                {done[step] ? <span className="sr-only"> {t('doneLabel')}</span> : null}
              </p>
              <p className="text-sm text-muted">{t(`firstTest.steps.${step}.hint`)}</p>
            </div>
            {done[step] || step === 'join' ? null : step === 'open' ? (
              <LinkButton
                variant="secondary"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpened(true)}
              >
                {t('firstTest.steps.open.action')}
              </LinkButton>
            ) : (
              <LinkButton variant="secondary" render={(p) => <Link to="/staff" {...p} />}>
                {t('firstTest.steps.call.action')}
              </LinkButton>
            )}
          </li>
        ))}
      </ol>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={() => update({ firstTestDismissed: true })}>
          {t(all ? 'firstTest.close' : 'firstTest.skip')}
        </Button>
      </div>
    </Card>
  );
}

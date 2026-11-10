import { Button, Card, Icon, iconCheck, iconCopy, LinkButton, Spinner } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useCurrentLocation } from '../auth/current.ts';
import { JoinQr } from '../admin/poster/JoinQr.tsx';
import { publicJoinUrl } from '../admin/poster/url.ts';
import type { Created } from './api.ts';

/**
 * The last wizard screen: the line exists, so share it. The join link and QR come first because
 * that is what makes the product useful; hours, team and a TV are optional follow-ups.
 * Whether a queue with no hours accepts guests is the database's call (a location with no weekly
 * hours is open all day), so this screen only says what it does.
 */
export function LineLive({ created }: { created: Created }) {
  const { t } = useTranslation('onboarding');
  const { location } = useCurrentLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => heading.current?.focus(), [location?.id]);

  if (!location) return <Spinner label={t('live.loading')} />;
  const url = publicJoinUrl(location.slug);
  const copy = async () => {
    // The clipboard needs a secure context; the link stays selectable either way.
    await navigator.clipboard?.writeText(url).then(
      () => setCopied(true),
      () => {},
    );
  };
  const template = created.template;

  return (
    <div className="mx-auto mt-8 flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <span className="inline-flex w-fit items-center gap-2 rounded-full bg-secondary px-3 py-1 text-sm font-semibold">
          <Icon icon={iconCheck} size="sm" />
          {t('live.badge')}
        </span>
        <h1 ref={heading} tabIndex={-1} className="text-3xl font-semibold outline-none">
          {t('live.title', { name: location.name })}
        </h1>
        <p className="max-w-prose text-muted">{t('live.intro')}</p>
        {template ? (
          <p role="status" className="text-sm text-muted">
            {t('templates.summary', {
              count: template.queuesCreated,
              services: template.servicesCreated,
              counters: template.countersCreated,
            })}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">{t('live.shareTitle')}</h2>
          <JoinQr
            url={url}
            label={t('live.qr', { url })}
            className="mx-auto w-44 max-w-full rounded-card border border-border"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <p
              data-testid="join-url"
              className="flex min-h-target flex-1 items-center break-all rounded-control border border-border px-3 font-mono text-sm"
            >
              {url}
            </p>
            <Button variant="secondary" onClick={() => void copy()}>
              <Icon icon={iconCopy} size="sm" />
              {t('live.copy')}
            </Button>
          </div>
          <p role="status" className="text-sm text-muted empty:hidden">
            {copied ? t('live.copied') : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <LinkButton render={(p) => <Link to="/admin/poster" {...p} />}>
              {t('live.poster')}
            </LinkButton>
            <LinkButton variant="secondary" href={url} target="_blank" rel="noopener noreferrer">
              {t('live.openPage')}
            </LinkButton>
          </div>
          <p className="text-sm text-muted">{t('live.tryIt')}</p>
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">{t('live.nextTitle')}</h2>
          <ul className="flex flex-col gap-4">
            <li className="flex flex-col gap-2">
              <div>
                <p className="font-semibold">{t('live.hours')}</p>
                <p className="text-sm text-muted">{t('live.hoursHint')}</p>
              </div>
              <LinkButton
                variant="secondary"
                className="w-fit"
                render={(p) => <Link to="/admin/location/hours" {...p} />}
              >
                {t('live.hoursAction')}
              </LinkButton>
            </li>
            <li className="flex flex-col gap-2">
              <div>
                <p className="font-semibold">{t('live.team')}</p>
                <p className="text-sm text-muted">{t('live.teamHint')}</p>
              </div>
              <LinkButton
                variant="secondary"
                className="w-fit"
                render={(p) => <Link to="/admin/team" {...p} />}
              >
                {t('live.teamAction')}
              </LinkButton>
            </li>
            <li className="flex flex-col gap-2">
              <div>
                <p className="font-semibold">{t('live.tv')}</p>
                <p className="text-sm text-muted">{t('live.tvHint')}</p>
              </div>
              <LinkButton
                variant="secondary"
                className="w-fit"
                render={(p) => <Link to="/admin/devices" {...p} />}
              >
                {t('live.tvAction')}
              </LinkButton>
            </li>
          </ul>
          {template ? (
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <LinkButton variant="secondary" render={(p) => <Link to="/admin/queues" {...p} />}>
                {t('templates.editQueues')}
              </LinkButton>
              <LinkButton variant="secondary" render={(p) => <Link to="/admin/counters" {...p} />}>
                {t('templates.editCounters')}
              </LinkButton>
            </div>
          ) : null}
        </Card>
      </div>

      <Card className="flex flex-col gap-2" data-testid="guest-alerts">
        <h2 className="text-lg font-semibold">{t('live.alerts.title')}</h2>
        <ul className="list-disc ps-5 text-sm text-muted">
          <li>{t('live.alerts.phone')}</li>
          <li>{t('live.alerts.browser')}</li>
          <li>{t('live.alerts.tv')}</li>
        </ul>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <LinkButton
          className="min-h-target-big px-6 text-lg"
          render={(p) => <Link to="/staff" {...p} />}
        >
          {t('live.console')}
        </LinkButton>
        <LinkButton variant="secondary" render={(p) => <Link to="/admin" {...p} />}>
          {t('live.dashboard')}
        </LinkButton>
      </div>
    </div>
  );
}

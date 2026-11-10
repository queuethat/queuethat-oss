import { errorCode } from '@qm/domain';
import { Button, Card, Checkbox, ConfirmDestructive, Input, Spinner } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { feedUrls, useCalendarFeeds, useCreateCalendarFeed, useRevokeCalendarFeed } from './api.ts';

/**
 * `/admin/account/calendar` (A-16): create, copy and revoke the calendar feed link. The link
 * is shown once, right after creating it; afterwards only a masked hint remains.
 */
export function CalendarFeedPage() {
  const { t, i18n } = useTranslation('account');
  const feeds = useCalendarFeeds();
  const create = useCreateCalendarFeed();
  const revoke = useRevokeCalendarFeed();
  const [names, setNames] = useState(false);
  // Held in memory only: a reload loses it, which is the point.
  const [fresh, setFresh] = useState<{ token: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const date = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(iso));

  async function copy(kind: 'https' | 'webcal', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setCopied(null);
    }
  }

  if (!feeds.data) return <Spinner label={t('calendar.loading')} />;
  const urls = fresh ? feedUrls(fresh.token) : null;
  const failure = create.error
    ? errorCode(create.error) === 'rate_limited' || create.error.message === 'rate_limited'
      ? 'rate_limited'
      : 'unknown'
    : null;

  return (
    <div className="flex flex-col gap-4 pb-8">
      <h1 className="text-2xl font-semibold">{t('calendar.title')}</h1>
      <p className="text-muted">{t('calendar.intro')}</p>

      <Card className="flex flex-col gap-3">
        <Checkbox
          label={t('calendar.names')}
          hint={t('calendar.namesHint')}
          checked={names}
          onChange={(e) => setNames(e.target.checked)}
        />
        <p role="note" className="rounded-control bg-warning-soft p-3 text-warning-strong">
          {t('calendar.warning')}
        </p>
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {failure ? t(`calendar.error.${failure}`) : null}
        </p>
        <Button
          loading={create.isPending}
          loadingLabel={t('calendar.creating')}
          onClick={() =>
            create.mutate(names, {
              onSuccess: ({ token }) => {
                setFresh({ token });
                setCopied(null);
              },
            })
          }
        >
          {t('calendar.create')}
        </Button>
      </Card>

      {urls ? (
        <Card className="flex flex-col gap-3" data-testid="new-feed">
          <h2 className="text-lg font-semibold">{t('calendar.newTitle')}</h2>
          <p>{t('calendar.newBody')}</p>
          <Input label={t('calendar.webcal')} readOnly value={urls.webcal} />
          <Button variant="secondary" onClick={() => void copy('webcal', urls.webcal)}>
            {t('calendar.copyWebcal')}
          </Button>
          <Input label={t('calendar.https')} readOnly value={urls.https} />
          <Button variant="secondary" onClick={() => void copy('https', urls.https)}>
            {t('calendar.copyHttps')}
          </Button>
          <p role="status" className="empty:hidden">
            {copied ? t('calendar.copied') : null}
          </p>
        </Card>
      ) : null}

      <h2 className="text-lg font-semibold">{t('calendar.active')}</h2>
      {feeds.data.length === 0 ? <p>{t('calendar.none')}</p> : null}
      <ul className="flex flex-col gap-3">
        {feeds.data.map((feed) => (
          <li key={feed.id}>
            <Card className="flex flex-wrap items-center justify-between gap-3" data-testid="feed">
              <div>
                <p className="font-mono">{t('calendar.masked')}</p>
                <p className="text-sm text-muted">
                  {t('calendar.created', { date: date(feed.createdAt) })}
                  {' · '}
                  {feed.lastAccessedAt
                    ? t('calendar.lastUsed', { date: date(feed.lastAccessedAt) })
                    : t('calendar.neverUsed')}
                  {feed.includeGuestNames ? ` · ${t('calendar.withNames')}` : ''}
                </p>
              </div>
              <ConfirmDestructive
                triggerLabel={t('calendar.revoke')}
                triggerVariant="secondary"
                title={t('calendar.revokeTitle')}
                description={t('calendar.revokeBody')}
                confirmLabel={t('calendar.revokeConfirm')}
                cancelLabel={t('calendar.revokeKeep')}
                onConfirm={() => revoke.mutateAsync(feed.id)}
              />
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

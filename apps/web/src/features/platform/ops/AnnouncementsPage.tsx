import {
  AnnouncementBanner,
  Button,
  ConfirmDestructive,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useNow } from '../../../lib/now.ts';
import {
  opsError,
  platformAnnouncementsQuery,
  useUpsertAnnouncement,
  type AnnouncementSeverity,
  type PlatformAnnouncement,
} from './api.ts';

const SEVERITIES: AnnouncementSeverity[] = ['info', 'warning', 'maintenance'];

/** An instant as a `datetime-local` value in this browser's zone. */
export function toLocalInput(iso: string): string {
  const at = new Date(iso);
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

interface Draft {
  id?: string;
  severity: AnnouncementSeverity;
  message: string;
  startsAt: string;
  endsAt: string;
}

const blank: Draft = { severity: 'info', message: '', startsAt: '', endsAt: '' };

/**
 * `/platform/announcements` (PLT13, #419): operators create, edit and end the banners every
 * signed-in user sees. Times are in the operator's own zone; the database stores instants.
 */
export function AnnouncementsPage() {
  const { t, i18n } = useTranslation('platform');
  const announcements = useQuery(platformAnnouncementsQuery);
  const now = useNow(60_000);
  const upsert = useUpsertAnnouncement();
  const [draft, setDraft] = useState<Draft>(blank);
  const edit = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const failure = upsert.error ? t(`ops.announcements.errors.${opsError(upsert.error)}`) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    upsert.mutate(
      {
        id: draft.id,
        severity: draft.severity,
        message: draft.message,
        startsAt: draft.startsAt ? new Date(draft.startsAt).toISOString() : undefined,
        endsAt: new Date(draft.endsAt).toISOString(),
      },
      { onSuccess: () => setDraft(blank) },
    );
  };
  // Ending one sets its end to now. A scheduled one also gets a start just before, since the
  // database requires the end to come after the start.
  const end = (a: PlatformAnnouncement) => {
    const endsAt = Date.now();
    const startsAt = new Date(Math.min(Date.parse(a.starts_at), endsAt - 1000)).toISOString();
    return upsert
      .mutateAsync({ ...a, startsAt, endsAt: new Date(endsAt).toISOString() })
      .catch(() => {});
  };
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('ops.announcements.title')} />
      <section aria-labelledby="announcements-live" className="flex flex-col gap-3">
        <h2 id="announcements-live" className="text-xl font-semibold">
          {t('ops.announcements.live')}
        </h2>
        {!announcements.data ? (
          announcements.isError ? (
            <EmptyState title={t('ops.loadFailed')} />
          ) : (
            <Spinner label={t('ops.loading')} />
          )
        ) : announcements.data.length === 0 ? (
          <EmptyState title={t('ops.announcements.none')} />
        ) : (
          <ul className="flex flex-col gap-3">
            {announcements.data.map((a) => (
              <li key={a.id} className="flex flex-col gap-2">
                <AnnouncementBanner
                  severity={a.severity}
                  label={t(`ops.announcements.severity.${a.severity}`)}
                  message={a.message}
                  dismissLabel=""
                />
                <p className="text-sm text-muted">
                  {Date.parse(a.starts_at) > now
                    ? t('ops.announcements.scheduled', {
                        start: time.format(new Date(a.starts_at)),
                        end: time.format(new Date(a.ends_at)),
                      })
                    : t('ops.announcements.until', { end: time.format(new Date(a.ends_at)) })}
                </p>
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="secondary"
                    aria-label={t('ops.announcements.editOne', { message: a.message })}
                    onClick={() =>
                      setDraft({
                        id: a.id,
                        severity: a.severity,
                        message: a.message,
                        startsAt: toLocalInput(a.starts_at),
                        endsAt: toLocalInput(a.ends_at),
                      })
                    }
                  >
                    {t('ops.announcements.edit')}
                  </Button>
                  <ConfirmDestructive
                    triggerLabel={t('ops.announcements.end')}
                    triggerAriaLabel={t('ops.announcements.endOne', { message: a.message })}
                    title={t('ops.announcements.endTitle')}
                    description={a.message}
                    confirmLabel={t('ops.announcements.endConfirm')}
                    cancelLabel={t('ops.cancel')}
                    onConfirm={() => end(a)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <form aria-labelledby="announcement-form" className="flex flex-col gap-4" onSubmit={submit}>
        <h2 id="announcement-form" className="text-xl font-semibold">
          {draft.id ? t('ops.announcements.editing') : t('ops.announcements.create')}
        </h2>
        <Select
          label={t('ops.announcements.severityLabel')}
          value={draft.severity}
          onChange={(e) => edit({ severity: e.target.value as AnnouncementSeverity })}
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {t(`ops.announcements.severity.${s}`)}
            </option>
          ))}
        </Select>
        <Input
          label={t('ops.announcements.message')}
          maxLength={500}
          value={draft.message}
          onChange={(e) => edit({ message: e.target.value })}
          required
        />
        <Input
          type="datetime-local"
          label={t('ops.announcements.startsAt')}
          hint={t('ops.announcements.startsHint')}
          value={draft.startsAt}
          onChange={(e) => edit({ startsAt: e.target.value })}
        />
        <Input
          type="datetime-local"
          label={t('ops.announcements.endsAt')}
          value={draft.endsAt}
          onChange={(e) => edit({ endsAt: e.target.value })}
          required
        />
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {failure}
        </p>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={upsert.isPending} loadingLabel={t('ops.saving')}>
            {draft.id ? t('ops.announcements.saveEdit') : t('ops.announcements.publish')}
          </Button>
          {draft.id ? (
            <Button variant="secondary" onClick={() => setDraft(blank)}>
              {t('ops.cancel')}
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

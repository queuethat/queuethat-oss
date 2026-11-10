import { Button, Input, Select, Skeleton, Textarea, useToast } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { GuestNoticePanel } from './guest-notice/GuestNoticePanel.tsx';
import {
  KINDS,
  incidentLogQuery,
  logToCsv,
  useReportIncident,
  useUpdateLogEntry,
  type LogEntry,
} from './api.ts';

const HEADERS = [
  'detected',
  'kind',
  'title',
  'description',
  'categories',
  'people',
  'actions',
  'regulator',
] as const;

/**
 * The business's own incident log (C9, #1275): "Report a suspected incident" adds an entry, and
 * the business records what it did about it. The export is the 24-month record. Information only: nothing here files a report with a regulator.
 */
export function IncidentLog({
  orgId,
  canEdit,
  isOwner = false,
}: {
  orgId: string;
  canEdit: boolean;
  isOwner?: boolean;
}) {
  const { t, i18n } = useTranslation('admin-privacy');
  const log = useQuery(incidentLogQuery(orgId));
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  if (log.isPending) return <Skeleton label={t('loading')} rows={3} />;
  const rows = log.data ?? [];

  function download() {
    const csv = logToCsv(
      HEADERS.map((h) => t(`privacy.incidents.col.${h}`)),
      rows,
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'incident-log.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-labelledby="incidents-h" id="incidents" className="flex flex-col gap-3">
      <h2 id="incidents-h" className="text-xl font-semibold">
        {t('privacy.incidents.title')}
      </h2>
      <p className="text-muted">{t('privacy.incidents.explain')}</p>
      {log.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('privacy.incidents.error')}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted" data-testid="incidents-none">
          {t('privacy.incidents.none')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {rows.map((r) => (
              <Entry
                key={r.id}
                entry={r}
                orgId={orgId}
                canEdit={canEdit}
                isOwner={isOwner}
                when={when}
              />
            ))}
          </ul>
          <div>
            <Button variant="secondary" onClick={download}>
              {t('privacy.incidents.export')}
            </Button>
          </div>
        </>
      )}
      {canEdit ? <Report orgId={orgId} /> : null}
    </section>
  );
}

function Entry({
  entry,
  orgId,
  canEdit,
  isOwner,
  when,
}: {
  entry: LogEntry;
  orgId: string;
  canEdit: boolean;
  isOwner: boolean;
  when: Intl.DateTimeFormat;
}) {
  const { t } = useTranslation('admin-privacy');
  const update = useUpdateLogEntry(orgId);
  const toast = useToast();
  const [people, setPeople] = useState(entry.people_affected?.toString() ?? '');
  const [actions, setActions] = useState(entry.actions_taken ?? '');
  const [regulator, setRegulator] = useState(entry.regulator_notified ?? '');
  const [description, setDescription] = useState(entry.description ?? '');
  const save = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        id: entry.id,
        description,
        peopleAffected: people === '' ? undefined : Number(people),
        actionsTaken: actions,
        regulatorNotified: regulator,
      },
      { onSuccess: () => toast.show({ message: t('privacy.incidents.saved') }) },
    );
  };
  return (
    <li
      className="flex flex-col gap-2 rounded border border-border p-3"
      data-testid="incident-entry"
    >
      <h3 className="font-semibold">{entry.title}</h3>
      <p className="text-muted">
        {when.format(new Date(entry.detected_at))} ·{' '}
        {t(`privacy.incidents.kind.${entry.kind as 'other'}`)}
      </p>
      {canEdit ? (
        <form className="flex flex-col gap-2" onSubmit={save}>
          <Textarea
            label={t('privacy.incidents.description')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Input
            label={t('privacy.incidents.people')}
            type="number"
            min={0}
            value={people}
            onChange={(e) => setPeople(e.target.value)}
          />
          <Textarea
            label={t('privacy.incidents.actions')}
            value={actions}
            onChange={(e) => setActions(e.target.value)}
          />
          <Input
            label={t('privacy.incidents.regulator')}
            value={regulator}
            onChange={(e) => setRegulator(e.target.value)}
          />
          <div>
            <Button type="submit" variant="secondary" disabled={update.isPending}>
              {t('privacy.incidents.save')}
            </Button>
          </div>
          {update.isError ? (
            <p role="alert" className="text-danger">
              {t('privacy.incidents.error')}
            </p>
          ) : null}
        </form>
      ) : null}
      {canEdit ? <GuestNoticePanel logId={entry.id} orgId={orgId} isOwner={isOwner} /> : null}
    </li>
  );
}

function Report({ orgId }: { orgId: string }) {
  const { t } = useTranslation('admin-privacy');
  const report = useReportIncident(orgId);
  const toast = useToast();
  const [kind, setKind] = useState<string>(KINDS[0]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    report.mutate(
      { kind, title, description },
      {
        onSuccess: () => {
          setTitle('');
          setDescription('');
          toast.show({ message: t('privacy.incidents.logged') });
        },
      },
    );
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={submit}
      aria-label={t('privacy.incidents.report')}
    >
      <h3 className="font-semibold">{t('privacy.incidents.report')}</h3>
      <Select
        label={t('privacy.incidents.kindLabel')}
        value={kind}
        onChange={(e) => setKind(e.target.value)}
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`privacy.incidents.kind.${k}`)}
          </option>
        ))}
      </Select>
      <Input
        label={t('privacy.incidents.titleLabel')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Textarea
        label={t('privacy.incidents.description')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <p className="text-muted">{t('privacy.incidents.notAdvice')}</p>
      <div>
        <Button type="submit" disabled={!title.trim() || report.isPending}>
          {t('privacy.incidents.submit')}
        </Button>
      </div>
      {report.isError ? (
        <p role="alert" className="text-danger">
          {t(
            report.error.message === 'rate_limited'
              ? 'privacy.incidents.rateLimited'
              : 'privacy.incidents.error',
          )}
        </p>
      ) : null}
    </form>
  );
}

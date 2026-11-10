import { Button, ConfirmDestructive, Select, Spinner, Textarea } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { NoticePanel } from './notify/NoticePanel.tsx';
import {
  STATUSES,
  incidentBreakGlassQuery,
  incidentTenantsQuery,
  incidentTimelineQuery,
  useAddIncidentNote,
  useUpdateIncident,
  type Incident,
  type IncidentStatus,
} from './api.ts';

interface Owner {
  email: string;
}

/** One incident open: its record, what to tell tenants, the timeline, and the break-glass link. */
export function IncidentDetail({ incident }: { incident: Incident }) {
  const id = incident.id ?? '';
  const { t, i18n } = useTranslation('platform');
  const timeline = useQuery(incidentTimelineQuery(id));
  const tenants = useQuery(incidentTenantsQuery(id));
  const glass = useQuery(incidentBreakGlassQuery(id));
  const update = useUpdateIncident(id);
  const addNote = useAddIncidentNote(id);
  const [status, setStatus] = useState<IncidentStatus>(incident.status ?? 'suspected');
  const [containment, setContainment] = useState(incident.containment ?? '');
  const [rootCause, setRootCause] = useState(incident.root_cause ?? '');
  const [lessons, setLessons] = useState(incident.lessons ?? '');
  const [note, setNote] = useState('');
  const [waive, setWaive] = useState('');
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const save = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ status, containment, rootCause, lessons });
  };
  const post = (event: FormEvent) => {
    event.preventDefault();
    addNote.mutate(note, { onSuccess: () => setNote('') });
  };

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid gap-1">
        <dt className="font-medium">{t('incidents.scope')}</dt>
        <dd>
          {t('incidents.scopeLine', {
            orgs: incident.org_ids?.length ?? 0,
            records: incident.record_count ?? t('incidents.unknownCount'),
            categories:
              (incident.data_categories ?? [])
                .map((c) => t(`incidents.category.${c as 'other'}`))
                .join(', ') || t('incidents.unknownCount'),
          })}
        </dd>
        <dt className="font-medium">{t('incidents.retainUntil')}</dt>
        <dd>{time.format(new Date(incident.retain_until ?? 0))}</dd>
      </dl>

      <section aria-label={t('incidents.tenants')} className="flex flex-col gap-2">
        <h3 className="font-semibold">{t('incidents.tenants')}</h3>
        {tenants.data?.length === 0 && <p className="text-muted">{t('incidents.noTenants')}</p>}
        <ul className="flex flex-col gap-1">
          {tenants.data?.map((o) => (
            <li key={o.org_id}>
              <strong>{o.org_name ?? o.org_id}</strong>:{' '}
              {((o.owners as Owner[] | null) ?? []).map((x) => x.email).join(', ') ||
                t('incidents.noOwner')}
              {' · '}
              {o.breach_contact
                ? (o.breach_contact as { email?: string }).email
                : t('incidents.noContact')}
            </li>
          ))}
        </ul>
      </section>

      <NoticePanel incidentId={id} />

      <form className="flex flex-col gap-4" onSubmit={save}>
        <Select
          label={t('incidents.statusLabel')}
          value={status}
          onChange={(e) => setStatus(e.target.value as IncidentStatus)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`incidents.status.${s}`)}
            </option>
          ))}
        </Select>
        <Textarea
          label={t('incidents.containment')}
          value={containment}
          onChange={(e) => setContainment(e.target.value)}
        />
        <Textarea
          label={t('incidents.rootCause')}
          value={rootCause}
          onChange={(e) => setRootCause(e.target.value)}
        />
        <Textarea
          label={t('incidents.lessons')}
          value={lessons}
          onChange={(e) => setLessons(e.target.value)}
        />
        {update.isError && (
          <p role="alert" className="text-danger">
            {t('ops.loadFailed')}
          </p>
        )}
        <div>
          <Button type="submit" disabled={update.isPending}>
            {t('incidents.save')}
          </Button>
        </div>
      </form>

      {incident.notify_state !== 'done' && (
        <div className="flex flex-col gap-3">
          <ConfirmDestructive
            triggerVariant="secondary"
            triggerLabel={t('incidents.markNotified')}
            title={t('incidents.markNotifiedTitle')}
            description={t('incidents.markNotifiedBody')}
            confirmLabel={t('incidents.markNotifiedConfirm')}
            cancelLabel={t('ops.cancel')}
            onConfirm={() => update.mutateAsync({ markNotified: true })}
          />
          <Textarea
            label={t('incidents.waive')}
            value={waive}
            onChange={(e) => setWaive(e.target.value)}
          />
          <div>
            <Button
              variant="secondary"
              disabled={!waive.trim() || update.isPending}
              onClick={() => update.mutate({ waiveReason: waive })}
            >
              {t('incidents.waiveSubmit')}
            </Button>
          </div>
        </div>
      )}

      <section aria-label={t('incidents.timeline')} className="flex flex-col gap-2">
        <h3 className="font-semibold">{t('incidents.timeline')}</h3>
        {!timeline.data ? (
          <Spinner label={t('ops.loading')} />
        ) : (
          <ol className="flex flex-col gap-1">
            {timeline.data.map((e) => (
              <li key={e.id}>
                {time.format(new Date(e.created_at))} · {t(`incidents.event.${e.kind as 'note'}`)}
                {e.body ? `: ${e.body}` : ''}
              </li>
            ))}
          </ol>
        )}
        <form className="flex flex-col gap-2" onSubmit={post}>
          <Textarea
            label={t('incidents.note')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div>
            <Button type="submit" variant="secondary" disabled={!note.trim() || addNote.isPending}>
              {t('incidents.addNote')}
            </Button>
          </div>
        </form>
      </section>

      <section aria-label={t('incidents.breakGlass')} className="flex flex-col gap-2">
        <h3 className="font-semibold">{t('incidents.breakGlass')}</h3>
        {glass.data?.length === 0 && <p className="text-muted">{t('incidents.noBreakGlass')}</p>}
        <ul className="flex flex-col gap-1">
          {glass.data?.map((g) => (
            <li key={`${g.at}-${g.org_id}`}>
              {time.format(new Date(g.at ?? 0))} · {g.org_name ?? g.org_id} · {g.operator_email} ·{' '}
              {g.reason}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

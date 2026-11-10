import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
  Textarea,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { IncidentDetail } from './IncidentDetail.tsx';
import { CATEGORIES, KINDS, incidentsQuery, useCreateIncident } from './api.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * `/platform/incidents` (C8, #1274): the breach register. Lists incidents with the 72-hour notify
 * clock the database computes (this page never re-derives it), files a new one, and opens one for
 * its scope, timeline, affected tenants and break-glass openings. Operators only.
 */
export function IncidentsPage() {
  const { t, i18n } = useTranslation('platform');
  const incidents = useQuery(incidentsQuery);
  const create = useCreateIncident();
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<string>(KINDS[0]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [orgs, setOrgs] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [count, setCount] = useState('');
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        kind,
        title,
        description,
        orgIds: [...new Set(orgs.match(UUID)?.map((id) => id.toLowerCase()))],
        categories,
        recordCount: count === '' ? undefined : Number(count),
      },
      {
        onSuccess: () => {
          setTitle('');
          setDescription('');
          setOrgs('');
          setCategories([]);
          setCount('');
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('incidents.title')} />
      <p className="text-muted">{t('incidents.intro')}</p>
      {!incidents.data ? (
        incidents.isError ? (
          <EmptyState
            title={
              incidents.error.message === 'permission_denied'
                ? t('incidents.denied')
                : t('ops.loadFailed')
            }
          />
        ) : (
          <Spinner label={t('ops.loading')} />
        )
      ) : incidents.data.length === 0 ? (
        <EmptyState title={t('incidents.none')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {incidents.data.map((i) => (
            <li key={i.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold">{i.title}</h2>
                  <Badge>{t(`incidents.status.${i.status ?? 'suspected'}`)}</Badge>
                  {i.escalated ? (
                    <Badge tone="danger">{t('incidents.overdue')}</Badge>
                  ) : i.notify_state === 'done' ? (
                    <Badge tone="success">{t('incidents.notified')}</Badge>
                  ) : (
                    <Badge tone="warning">
                      {t('incidents.due', { time: time.format(new Date(i.notify_due_at ?? 0)) })}
                    </Badge>
                  )}
                </div>
                <p className="text-muted">
                  {t(`incidents.kinds.${(i.kind ?? 'other') as (typeof KINDS)[number]}`)} ·{' '}
                  {t('incidents.detected', { time: time.format(new Date(i.detected_at ?? 0)) })}
                </p>
                <div>
                  <Button
                    variant="secondary"
                    aria-expanded={open === i.id}
                    onClick={() => setOpen(open === i.id ? null : (i.id ?? null))}
                  >
                    {open === i.id ? t('incidents.hide') : t('incidents.open')}
                  </Button>
                </div>
                {open === i.id && <IncidentDetail incident={i} />}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <form aria-labelledby="incident-form" className="flex flex-col gap-4" onSubmit={submit}>
        <h2 id="incident-form" className="text-xl font-semibold">
          {t('incidents.file')}
        </h2>
        <Select label={t('incidents.kind')} value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`incidents.kinds.${k}`)}
            </option>
          ))}
        </Select>
        <Input
          label={t('incidents.name')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <Textarea
          label={t('incidents.description')}
          hint={t('incidents.noContactHint')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Textarea
          label={t('incidents.orgs')}
          hint={t('incidents.orgsHint')}
          value={orgs}
          onChange={(e) => setOrgs(e.target.value)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">{t('incidents.categories')}</legend>
          {CATEGORIES.map((c) => (
            <Checkbox
              key={c}
              label={t(`incidents.category.${c}`)}
              checked={categories.includes(c)}
              onChange={(e) =>
                setCategories(
                  e.target.checked ? [...categories, c] : categories.filter((x) => x !== c),
                )
              }
            />
          ))}
        </fieldset>
        <Input
          label={t('incidents.records')}
          type="number"
          min={0}
          value={count}
          onChange={(e) => setCount(e.target.value)}
        />
        {create.isError && (
          <p role="alert" className="text-danger">
            {create.error.message === 'invalid_input'
              ? t('incidents.invalid')
              : t('ops.loadFailed')}
          </p>
        )}
        <div>
          <Button type="submit" disabled={create.isPending || !title.trim()}>
            {t('incidents.fileSubmit')}
          </Button>
        </div>
      </form>
    </div>
  );
}

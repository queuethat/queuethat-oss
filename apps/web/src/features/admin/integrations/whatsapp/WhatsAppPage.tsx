import {
  Badge,
  Button,
  ConfirmDestructive,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentOrg } from '../../../auth/current.ts';
import {
  canManageWhatsApp,
  useMapTemplate,
  useRemoveMapping,
  useSyncTemplates,
  whatsappQuery,
  type WaCategory,
  type WhatsAppRow,
} from './api.ts';

const TONES = {
  approved: 'success',
  pending: 'neutral',
  paused: 'warning',
  rejected: 'danger',
} as const;
const MAP_ERRORS = ['category_mismatch', 'invalid_template', 'permission_denied'];

/** `/admin/whatsapp` (3-WA4, #361): which notifications can go out on WhatsApp, and their Meta template status. */
export function WhatsAppPage() {
  const { t } = useTranslation('admin-whatsapp');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('title')} />
      <TemplateList orgId={org.id} canManage={canManageWhatsApp(org.role)} />
    </div>
  );
}

function TemplateList({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const { t } = useTranslation('admin-whatsapp');
  const query = useQuery(whatsappQuery(orgId));
  const sync = useSyncTemplates(orgId);
  const remove = useRemoveMapping(orgId);
  const [mapping, setMapping] = useState<WhatsAppRow | null>(null);

  if (query.isError) return <p role="alert">{t('errors.unknown')}</p>;
  if (!query.data) return <Skeleton label={t('loading')} rows={2} />;
  const rows = query.data;
  const calledReady = rows.some((r) => r.trigger === 'called' && r.mapping?.status === 'approved');
  return (
    <section className="flex flex-col gap-4" aria-labelledby="wa-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="wa-heading" className="text-xl font-semibold">
          {t('list.title')}
        </h2>
        {canManage ? (
          <Button
            variant="secondary"
            loading={sync.isPending}
            loadingLabel={t('sync.running')}
            onClick={() => sync.mutate()}
          >
            {t('sync.button')}
          </Button>
        ) : null}
      </div>
      <p className="text-muted">{t('list.intro')}</p>
      {!canManage ? <p className="text-muted">{t('readOnly')}</p> : null}
      {rows.length > 0 && !calledReady ? <p role="status">{t('warning.called')}</p> : null}
      {sync.isError ? (
        <p role="alert">
          {t(`sync.errors.${sync.error.message}` as 'sync.errors.unknown', {
            defaultValue: t('sync.errors.unknown'),
          })}
        </p>
      ) : null}
      {sync.isSuccess ? <p role="status">{t('sync.done', { count: sync.data.updated })}</p> : null}
      {rows.length === 0 ? (
        <EmptyState title={t('list.empty')} />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((r) => (
            <li
              key={r.templateId}
              className="flex flex-wrap items-center justify-between gap-3 py-4"
              data-testid="wa-template"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-semibold">
                  {t(`triggers.${r.trigger}` as 'triggers.called', { defaultValue: r.trigger })} ·{' '}
                  {r.locale}
                </p>
                {r.mapping ? (
                  <p className="text-muted break-all">
                    {r.mapping.name} · {r.mapping.language} · {t(`category.${r.mapping.category}`)}{' '}
                    <Badge tone={TONES[r.mapping.status]}>
                      {t(`status.${r.mapping.status}` as 'status.pending')}
                    </Badge>
                  </p>
                ) : (
                  <p className="text-muted">{t('list.unmapped')}</p>
                )}
                {r.mapping?.status === 'rejected' ? (
                  <p className="text-muted">{t('list.rejectedHint')}</p>
                ) : null}
              </div>
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  {r.mapping ? (
                    <ConfirmDestructive
                      triggerLabel={t('remove.trigger')}
                      triggerAriaLabel={t('remove.triggerFor', { name: r.mapping.name })}
                      title={t('remove.title', { name: r.mapping.name })}
                      description={t('remove.description')}
                      confirmLabel={t('remove.confirm')}
                      cancelLabel={t('remove.cancel')}
                      triggerVariant="secondary"
                      onConfirm={() => remove.mutateAsync(r.mapping!.id)}
                    />
                  ) : (
                    <Button onClick={() => setMapping(r)}>{t('map.open')}</Button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <MapDialog orgId={orgId} row={mapping} onClose={() => setMapping(null)} />
    </section>
  );
}

function MapDialog({
  orgId,
  row,
  onClose,
}: {
  orgId: string;
  row: WhatsAppRow | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin-whatsapp');
  const map = useMapTemplate(orgId);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en_US');
  const [category, setCategory] = useState<WaCategory>('utility');
  const close = () => {
    map.reset();
    setName('');
    onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (row)
      map.mutate({ templateId: row.templateId, name, language, category }, { onSuccess: close });
  };
  const failure = map.error
    ? MAP_ERRORS.includes(map.error.message)
      ? map.error.message
      : 'unknown'
    : null;
  return (
    <Dialog open={!!row} onClose={close} title={t('map.title')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Input
          label={t('map.name')}
          hint={t('map.nameHint')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label={t('map.language')}
          required
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        />
        <Select
          label={t('map.category')}
          value={category}
          onChange={(e) => setCategory(e.target.value as WaCategory)}
        >
          <option value="utility">{t('category.utility')}</option>
          <option value="marketing">{t('category.marketing')}</option>
        </Select>
        {failure ? <p role="alert">{t(`errors.${failure}` as 'errors.unknown')}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={close}>
            {t('map.cancel')}
          </Button>
          <Button type="submit" loading={map.isPending} loadingLabel={t('map.saving')}>
            {t('map.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

import { Badge, Button, Card, Input, PageHeader, Skeleton, Textarea } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentOrg } from '../../../auth/current.ts';
import { accessibleTextColor, isHexColor, whiteTextPasses } from '@qm/domain';
import {
  EDITABLE_CHANNELS,
  EDITABLE_TRIGGERS,
  templatesQuery,
  type EditableChannel,
  type EditableTrigger,
} from '../../templates/api.ts';
import { TemplateEditor } from '../../templates/TemplatesPage.tsx';
import { canManageQueues } from '../api.ts';
import { queueLookQuery, useSaveQueueLook, WELCOME_MAX, type QueueLook } from './api.ts';

/** Q-15 (#238): one queue's own wording and look, over the organization's defaults. */
export function QueueOverridesPage({ queueId }: { queueId: string }) {
  const { t } = useTranslation('admin-templates');
  const org = useCurrentOrg();
  const look = useQuery(queueLookQuery(queueId));
  const templates = useQuery({ ...templatesQuery(org?.id ?? '', queueId), enabled: !!org });
  const [editing, setEditing] = useState<{ trigger: EditableTrigger; medium: EditableChannel }>();
  if (!org || !look.data || !templates.data) return <Skeleton label={t('loading')} rows={2} />;
  const readOnly = !canManageQueues(org.role);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <PageHeader
        title={t('queue.title', { name: look.data.name })}
        actions={
          <Link to="/admin/queues" className="inline-flex min-h-target items-center underline">
            {t('queue.back')}
          </Link>
        }
      />
      {readOnly ? <p className="text-muted">{t('readOnly')}</p> : null}
      <LookForm look={look.data} readOnly={readOnly} />
      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t('queue.messages')}</h2>
        <p className="text-muted">{t('queue.messagesIntro')}</p>
        <ul className="flex flex-col gap-2">
          {EDITABLE_TRIGGERS.flatMap((trigger) =>
            EDITABLE_CHANNELS.map((channel) => {
              const rows = templates.data.filter(
                (r) => r.trigger === trigger && r.medium === channel,
              );
              const own = rows.find((r) => r.queueId === queueId);
              const base =
                rows.find((r) => r.orgId !== null && r.queueId === null) ??
                rows.find((r) => r.orgId === null);
              const isEditing = editing?.trigger === trigger && editing.medium === channel;
              const name = `${t(`trigger.${trigger}`)} · ${t(`channel.${channel}`)}`;
              return (
                <li key={`${trigger}-${channel}`} className="rounded-card border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{name}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone={own ? 'info' : 'neutral'}>
                        {t(own ? 'queue.overridden' : 'queue.usesDefault')}
                      </Badge>
                      <Button
                        variant="secondary"
                        aria-label={t(readOnly ? 'viewLabel' : 'editLabel', {
                          trigger: t(`trigger.${trigger}`),
                          channel: t(`channel.${channel}`),
                        })}
                        aria-expanded={isEditing}
                        onClick={() =>
                          setEditing(isEditing ? undefined : { trigger, medium: channel })
                        }
                      >
                        {t(readOnly ? 'view' : 'edit')}
                      </Button>
                    </span>
                  </div>
                  {isEditing ? (
                    <TemplateEditor
                      key={`${trigger}-${channel}-${own?.version ?? 0}`}
                      orgId={org.id}
                      queueId={queueId}
                      trigger={trigger}
                      medium={channel}
                      custom={own}
                      system={base}
                      readOnly={readOnly}
                      onDone={() => setEditing(undefined)}
                    />
                  ) : null}
                </li>
              );
            }),
          )}
        </ul>
      </Card>
    </div>
  );
}

/** The accent must read on the light page (4.5:1, WCAG AA): the form refuses one that doesn't. */
function LookForm({ look, readOnly }: { look: QueueLook; readOnly: boolean }) {
  const { t } = useTranslation('admin-templates');
  const save = useSaveQueueLook(look.id);
  const [accent, setAccent] = useState(look.accent ?? '');
  const [welcome, setWelcome] = useState(look.welcomeText ?? '');
  const invalid = accent !== '' && !isHexColor(accent);
  const tooLight = accent !== '' && !invalid && !whiteTextPasses(accent);
  const [saved, setSaved] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (invalid || tooLight) return;
    save.mutate({ accent, welcomeText: welcome }, { onSuccess: () => setSaved(true) });
  };
  const error = invalid
    ? t('queue.accent.invalid')
    : tooLight
      ? t('queue.accent.low', { text: t(`queue.accent.${accessibleTextColor(accent)}`) })
      : save.isError
        ? t('queue.saveFailed')
        : null;
  return (
    <Card className="flex flex-col gap-3">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <h2 className="text-lg font-semibold">{t('queue.look')}</h2>
        <Input
          label={t('queue.accent.label')}
          hint={t('queue.accent.hint')}
          value={accent}
          disabled={readOnly}
          error={error ?? undefined}
          onChange={(e) => setAccent(e.target.value.trim())}
        />
        {accent && !invalid ? (
          <p
            data-testid="accent-preview"
            className="rounded-control px-4 py-3 font-semibold"
            style={{ backgroundColor: accent, color: accessibleTextColor(accent) }}
          >
            {t('queue.accent.preview')}
          </p>
        ) : null}
        <Textarea
          label={t('queue.welcome.label')}
          hint={t('queue.welcome.hint', { count: WELCOME_MAX - welcome.length })}
          maxLength={WELCOME_MAX}
          value={welcome}
          disabled={readOnly}
          onChange={(e) => setWelcome(e.target.value)}
        />
        {readOnly ? null : (
          <div className="flex items-center gap-3">
            <Button type="submit" loading={save.isPending} loadingLabel={t('saving')}>
              {t('queue.saveLook')}
            </Button>
            {saved ? <span role="status">{t('queue.saved')}</span> : null}
          </div>
        )}
      </form>
    </Card>
  );
}

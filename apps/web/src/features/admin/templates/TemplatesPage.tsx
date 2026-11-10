import { appConfig } from '../../../lib/config.ts';
import { renderTemplate, SAMPLE_TEMPLATE_VARS, smsSegments, TEMPLATE_VARIABLES } from '@qm/domain';
import { Badge, Button, ConfirmDestructive, Input, PageHeader, Skeleton, Textarea } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import {
  EDITABLE_CHANNELS,
  EDITABLE_TRIGGERS,
  templatesQuery,
  TemplateSaveError,
  useRevertTemplate,
  useSaveTemplate,
  useTemplateVersions,
  type EditableChannel,
  type EditableTrigger,
  type TemplateRow,
} from './api.ts';

type TemplateState = 'custom' | 'default' | 'off';
const STATE = { custom: 'custom', default: 'default', off: 'off' } as const;

const canEdit = (role: string | undefined) =>
  role === 'manager' || role === 'admin' || role === 'owner';

/** N-10 (#179): reword what guests are sent, per trigger and channel, with a live preview. */
export function TemplatesPage() {
  const { t } = useTranslation('admin-templates');
  const org = useCurrentOrg();
  const templates = useQuery({ ...templatesQuery(org?.id ?? ''), enabled: !!org });
  const [editing, setEditing] = useState<{ trigger: EditableTrigger; medium: EditableChannel }>();
  if (!org || !templates.data) return <Skeleton label={t('loading')} rows={2} />;
  const readOnly = !canEdit(org.role);
  const find = (trigger: string, channel: string, own: boolean) =>
    templates.data.find(
      (r) => r.trigger === trigger && r.medium === channel && (r.orgId !== null) === own,
    );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader
        title={t('title')}
        description={
          <>
            {t('intro')}
            {readOnly ? <span className="block">{t('readOnly')}</span> : null}
            <span className="block" data-testid="telegram-status">
              {appConfig().telegramBot
                ? t('telegram.configured', { bot: appConfig().telegramBot })
                : t('telegram.notConfigured')}
            </span>
          </>
        }
      />
      <ul className="flex flex-col gap-2">
        {EDITABLE_TRIGGERS.flatMap((trigger) =>
          EDITABLE_CHANNELS.map((channel) => {
            const custom = find(trigger, channel, true);
            const system = find(trigger, channel, false);
            const state: TemplateState = custom ? STATE.custom : system ? STATE.default : STATE.off;
            const isEditing = editing?.trigger === trigger && editing.medium === channel;
            return (
              <li key={`${trigger}-${channel}`} className="rounded-card border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {t(`trigger.${trigger}`)} · {t(`channel.${channel}`)}
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone={state === 'custom' ? 'info' : 'neutral'}>
                      {t(`state.${state}`)}
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
                    key={`${trigger}-${channel}-${custom?.version ?? 0}`}
                    orgId={org.id}
                    trigger={trigger}
                    medium={channel}
                    custom={custom}
                    system={system}
                    readOnly={readOnly}
                    onDone={() => setEditing(undefined)}
                  />
                ) : null}
              </li>
            );
          }),
        )}
      </ul>
    </div>
  );
}

/** The editor for one trigger and channel; `queueId` makes saving create a queue override. */
export function TemplateEditor({
  orgId,
  queueId,
  trigger,
  medium,
  custom,
  system,
  readOnly,
  onDone,
}: {
  orgId: string;
  queueId?: string;
  trigger: EditableTrigger;
  medium: EditableChannel;
  custom: TemplateRow | undefined;
  system: TemplateRow | undefined;
  readOnly: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation('admin-templates');
  const start = custom ?? system;
  const [body, setBody] = useState(start?.body ?? '');
  const [subject, setSubject] = useState(start?.subject ?? '');
  const save = useSaveTemplate(orgId, queueId);
  const revert = useRevertTemplate(orgId);
  const versions = useTemplateVersions(custom?.id);
  const preview = renderTemplate(body, SAMPLE_TEMPLATE_VARS);
  const sms = medium === 'sms' ? smsSegments(preview) : null;
  const error = save.error instanceof TemplateSaveError ? save.error : null;
  const failure = error
    ? error.code === 'unknown_variable'
      ? t('error.unknown_variable', { name: error.detail ?? '' })
      : t(
          `error.${['permission_denied', 'invalid_input'].includes(error.code) ? error.code : 'unknown'}` as 'error.unknown',
        )
    : null;

  return (
    <div className="mt-3 flex flex-col gap-3">
      {medium === 'email' ? (
        <Input
          label={t('subject')}
          value={subject}
          disabled={readOnly}
          onChange={(e) => setSubject(e.target.value)}
        />
      ) : null}
      <Textarea
        label={t('body')}
        hint={t('bodyHint')}
        value={body}
        disabled={readOnly}
        onChange={(e) => setBody(e.target.value)}
      />
      {readOnly ? null : (
        <div role="group" aria-label={t('variables')} className="flex flex-wrap gap-2">
          {TEMPLATE_VARIABLES[trigger]?.map((name) => (
            <Button
              key={name}
              variant="secondary"
              aria-label={t('insert', { name })}
              onClick={() => setBody((b) => `${b}{{${name}}}`)}
            >
              {name}
            </Button>
          ))}
        </div>
      )}
      <div>
        <p className="font-medium">{t('preview')}</p>
        <p data-testid="preview" className="whitespace-pre-wrap rounded-card bg-surface-raised p-3">
          {preview}
        </p>
        {sms ? (
          <p data-testid="segments" className="text-muted">
            {t('segments', { count: sms.segments })} · {t(`encoding.${sms.encoding}`)} ·{' '}
            {t('units', { count: sms.chars })}
          </p>
        ) : null}
      </div>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure}
      </p>
      {readOnly ? null : (
        <div className="flex flex-wrap gap-2">
          <Button
            loading={save.isPending}
            loadingLabel={t('saving')}
            disabled={!body.trim()}
            // mutateAsync, not mutate's own onSuccess: saving bumps the version, which remounts this
            // editor before that callback runs, and the callback is dropped with the old instance.
            onClick={() =>
              void save
                .mutateAsync({
                  draft: { trigger, medium: medium, subject, body },
                  existingId: custom?.id,
                })
                .then(onDone, () => undefined)
            }
          >
            {t('save')}
          </Button>
          {custom ? (
            <ConfirmDestructive
              triggerLabel={t('revert')}
              title={t('revertTitle')}
              description={t('revertDescription')}
              confirmLabel={t('revertConfirm')}
              cancelLabel={t('revertCancel')}
              onConfirm={() => revert.mutateAsync(custom.id).then(onDone)}
            />
          ) : null}
        </div>
      )}
      {custom && versions.data?.length ? (
        <section aria-label={t('history')}>
          <h3 className="font-medium">{t('history')}</h3>
          <ul className="text-muted">
            {versions.data.map((v) => (
              <li key={v.version}>
                {t('version', { n: v.version })} · {new Date(v.changedAt).toLocaleString()} ·{' '}
                {v.body}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

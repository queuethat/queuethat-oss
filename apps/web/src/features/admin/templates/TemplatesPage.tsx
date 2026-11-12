import { appConfig } from '../../../lib/config.ts';
import { renderTemplate, SAMPLE_TEMPLATE_VARS, TEMPLATE_VARIABLES } from '@qm/domain';
import {
  Badge,
  Button,
  Card,
  ConfirmDestructive,
  Input,
  PageHeader,
  Skeleton,
  Tabs,
  Textarea,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { TestText } from './TestText.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import {
  EDITABLE_CHANNELS,
  EDITABLE_TRIGGERS,
  TEMPLATE_LOCALES,
  templatesQuery,
  TemplateSaveError,
  useRevertTemplate,
  useSaveTemplate,
  useSmsPreview,
  useTemplateVersions,
  type EditableChannel,
  type EditableTrigger,
  type TemplateLocale,
  type TemplateRow,
} from './api.ts';

type TemplateState = 'custom' | 'default' | 'off';
const STATE = { custom: 'custom', default: 'default', off: 'off' } as const;

const canEdit = (role: string | undefined) =>
  role === 'manager' || role === 'admin' || role === 'owner';

/** The value after it has stopped changing for `ms`, so typing does not call the database per keystroke. */
function useSettled<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * N-10 (#179), S2 (#1219): reword what guests are sent, one card per message, per channel and
 * guest language. SMS previews come from the database with the locked frame shown but not editable.
 */
export function TemplatesPage() {
  const { t } = useTranslation('admin-templates');
  const org = useCurrentOrg();
  const [locale, setLocale] = useState<TemplateLocale>('en');
  const templates = useQuery({
    ...templatesQuery(org?.id ?? '', undefined, locale),
    enabled: !!org,
  });
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
      <Tabs
        label={t('language.label')}
        items={TEMPLATE_LOCALES.map((l) => ({ id: l, label: t(`language.${l}`) }))}
        value={locale}
        onChange={(id) => {
          setLocale(id as TemplateLocale);
          setEditing(undefined);
        }}
        panelId="template-cards"
      />
      <div id="template-cards" role="tabpanel" className="flex flex-col gap-4">
        {EDITABLE_TRIGGERS.map((trigger) => (
          <Card key={trigger} className="flex flex-col gap-2 p-4">
            <h2 className="font-semibold">{t(`trigger.${trigger}`)}</h2>
            <ul className="flex flex-col gap-2">
              {EDITABLE_CHANNELS.map((channel) => {
                const custom = find(trigger, channel, true);
                const system = find(trigger, channel, false);
                const state: TemplateState = custom
                  ? STATE.custom
                  : system
                    ? STATE.default
                    : STATE.off;
                const isEditing = editing?.trigger === trigger && editing.medium === channel;
                return (
                  <li
                    key={`${trigger}-${channel}`}
                    className="rounded-card border border-border p-3"
                  >
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
                        key={`${trigger}-${channel}-${locale}-${custom?.version ?? 0}`}
                        orgId={org.id}
                        trigger={trigger}
                        medium={channel}
                        locale={locale}
                        custom={custom}
                        system={system}
                        readOnly={readOnly}
                        onDone={() => setEditing(undefined)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** The editor for one trigger and channel; `queueId` makes saving create a queue override. */
export function TemplateEditor({
  orgId,
  queueId,
  trigger,
  medium,
  locale = 'en',
  custom,
  system,
  readOnly,
  onDone,
}: {
  orgId: string;
  queueId?: string;
  trigger: EditableTrigger;
  medium: EditableChannel;
  locale?: TemplateLocale;
  custom: TemplateRow | undefined;
  system: TemplateRow | undefined;
  readOnly: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation('admin-templates');
  const start = custom ?? system;
  const [body, setBody] = useState(start?.body ?? '');
  const [subject, setSubject] = useState(start?.subject ?? '');
  const save = useSaveTemplate(orgId, queueId, locale);
  const revert = useRevertTemplate(orgId);
  const versions = useTemplateVersions(custom?.id);
  const isSms = medium === 'sms';
  const settledBody = useSettled(body);
  // SMS: the database composes the text (frame, samples, measure); other channels have no frame.
  const sms = useSmsPreview(orgId, trigger, locale, settledBody, isSms && !!settledBody.trim());
  // What guests of this language get today, to say when it is an override written in another language.
  const current = useSmsPreview(orgId, trigger, locale, undefined, isSms && !custom && !queueId);
  const preview = isSms ? null : renderTemplate(body, SAMPLE_TEMPLATE_VARS);
  const guardReason = (detail = '') =>
    ['url', 'contact', 'length', 'unsubscribe_url'].includes(detail)
      ? t(`guard.${detail}` as 'guard.url')
      : /segments$/.test(detail)
        ? t('guard.segments')
        : /^[a-z_]+_name$|^(counter|service)$/.test(detail)
          ? t('guard.adjacent', { name: detail })
          : t('guard.term', { term: detail });
  const error = save.error instanceof TemplateSaveError ? save.error : null;
  const failure = error
    ? error.code === 'unknown_variable'
      ? t('error.unknown_variable', { name: error.detail ?? '' })
      : error.code === 'template_guard'
        ? t('error.template_guard', { detail: guardReason(error.detail) })
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
      {current.data?.source === 'custom_other_locale' ? (
        <p data-testid="other-locale" className="rounded-card bg-surface-raised p-3">
          {t('otherLocale')}
        </p>
      ) : null}
      <div>
        <p className="font-medium">{t(isSms ? 'previewSms' : 'preview')}</p>
        {isSms ? (
          sms.data ? (
            <>
              <p
                data-testid="preview"
                className="whitespace-pre-wrap rounded-card bg-surface-raised p-3"
              >
                <span data-testid="frame-prefix" className="text-muted" title={t('locked')}>
                  {sms.data.prefix}
                </span>
                <span>{sms.data.body}</span>{' '}
                <span data-testid="frame-footer" className="text-muted" title={t('locked')}>
                  {sms.data.footer}
                </span>
              </p>
              <p className="text-muted">{t('lockedHint')}</p>
              <p data-testid="segments" className="text-muted">
                {t('segments', { count: sms.data.segments })} · {t(`encoding.${sms.data.encoding}`)}
              </p>
            </>
          ) : null
        ) : (
          <p
            data-testid="preview"
            className="whitespace-pre-wrap rounded-card bg-surface-raised p-3"
          >
            {preview}
          </p>
        )}
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
      {isSms && !readOnly && !queueId ? <TestText orgId={orgId} trigger={trigger} /> : null}
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

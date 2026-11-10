import {
  Button,
  Checkbox,
  Input,
  PageHeader,
  ScrollRegion,
  Skeleton,
  Spinner,
  Textarea,
  useToast,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../../auth/current.ts';
import {
  canEditProviders,
  canSwitchChannels,
  providerSettingsQuery,
  useSaveProviderSettings,
  useSetChannelEnabled,
} from '../../integrations/providers/api.ts';
import type { Dimension, Measure, ReportRow } from '../custom/api.ts';
import { useAskAnalytics } from './api.ts';

const KNOWN = [
  'analytics_disabled',
  'rate_limited',
  'couldnt_answer',
  'invalid_input',
  'permission_denied',
  'llm_unavailable',
];
const errorKey = (message: string | undefined) =>
  `ask.errors.${message && KNOWN.includes(message) ? message : 'unknown'}` as 'ask.errors.unknown';

/** `/admin/reports/ask` (4-AI1, #394): ask a question in plain language, get a validated report and a short summary. */
export function AskAnalyticsPage() {
  const { t } = useTranslation('admin-reports');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  const manager = ['manager', 'admin', 'owner'].includes(org.role);
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('ask.title')} />
      {manager ? (
        <Ask orgId={org.id} role={org.role} />
      ) : (
        <p className="text-muted">{t('ask.managersOnly')}</p>
      )}
    </div>
  );
}

function Ask({ orgId, role }: { orgId: string; role: string }) {
  const { t } = useTranslation('admin-reports');
  const settings = useQuery(providerSettingsQuery(orgId));
  if (settings.isError) return <p role="alert">{t('ask.errors.unknown')}</p>;
  if (!settings.data) return <Skeleton label={t('loading')} rows={2} />;
  const llm = settings.data.find((s) => (s.kind as string) === 'llm');
  return (
    <>
      <p className="text-muted">{t('ask.intro')}</p>
      {llm?.enabled ? <Asker orgId={orgId} /> : <p>{t('ask.off')}</p>}
      {canEditProviders(role) ? (
        <Setup
          orgId={orgId}
          role={role}
          hint={llm?.secret_hints ? (llm.secret_hints as Record<string, string>).api_key : ''}
          enabled={!!llm?.enabled}
          hasKey={!!llm}
        />
      ) : null}
    </>
  );
}

function Asker({ orgId }: { orgId: string }) {
  const { t } = useTranslation('admin-reports');
  const { location } = useCurrentLocation();
  const ask = useAskAnalytics(orgId);
  const [question, setQuestion] = useState('');
  const [all, setAll] = useState(false);
  const answer = ask.data;
  const cell = (r: ReportRow, d: Dimension) =>
    d === 'weekday' ? t(`weekdays.${r.dims[d]}` as 'weekdays.1') : String(r.dims[d] ?? '');
  return (
    <section className="flex flex-col gap-4" aria-label={t('ask.title')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask.mutate({ question: question.trim(), locationId: all ? undefined : location?.id });
        }}
      >
        <Textarea
          label={t('ask.question')}
          hint={t('ask.hint')}
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Checkbox
          label={t('ask.allLocations')}
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        <div>
          <Button type="submit" disabled={!question.trim() || ask.isPending}>
            {t('ask.submit')}
          </Button>
        </div>
      </form>
      {ask.isPending ? <Spinner label={t('ask.thinking')} /> : null}
      {ask.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t(errorKey(ask.error.message))}
        </p>
      ) : null}
      {answer ? (
        <div className="flex flex-col gap-4" data-testid="answer">
          {answer.summary ? <p data-testid="summary">{answer.summary}</p> : null}
          <p className="text-muted">
            {t('ask.ran', {
              measures: answer.definition.measures.map((m) => t(`custom.field.${m}`)).join(', '),
              from: answer.definition.from,
              to: answer.definition.to,
            })}
          </p>
          {answer.rows.length === 0 ? (
            <p>{t('custom.empty')}</p>
          ) : (
            <ScrollRegion label={t('custom.results')}>
              <table className="w-full text-left">
                <thead>
                  <tr>
                    {[...answer.definition.dimensions, ...answer.definition.measures].map((k) => (
                      <th key={k} scope="col" className="p-2">
                        {t(`custom.field.${k}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {answer.rows.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      {answer.definition.dimensions.map((d) => (
                        <td key={d} className="p-2">
                          {cell(r, d)}
                        </td>
                      ))}
                      {answer.definition.measures.map((m: Measure) => (
                        <td key={m} className="p-2">
                          {r.measures[m] ?? '–'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          )}
          <p className="text-muted">{t('ask.remaining', { count: answer.remaining })}</p>
        </div>
      ) : null}
    </section>
  );
}

function Setup(props: {
  orgId: string;
  role: string;
  hint: string | undefined;
  enabled: boolean;
  hasKey: boolean;
}) {
  const { t } = useTranslation('admin-reports');
  const toast = useToast();
  const save = useSaveProviderSettings(props.orgId);
  const toggle = useSetChannelEnabled(props.orgId);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [cap, setCap] = useState('50');
  return (
    <section
      className="flex flex-col gap-3 border-t border-border pt-4"
      aria-labelledby="ask-setup"
    >
      <h2 id="ask-setup" className="text-xl font-semibold">
        {t('ask.setup.title')}
      </h2>
      <p className="text-muted">{t('ask.setup.intro')}</p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(
            {
              kind: 'llm',
              provider: 'anthropic',
              mode: 'own',
              config: { ...(model ? { model } : {}), daily_cap: cap },
              secrets: key ? { api_key: key } : {},
            },
            {
              onSuccess: () => {
                setKey('');
                toast.show({ message: t('ask.setup.saved') });
              },
              onError: () => toast.show({ message: t('ask.errors.unknown'), tone: 'danger' }),
            },
          );
        }}
      >
        <Input
          label={t('ask.setup.key')}
          type="password"
          autoComplete="off"
          value={key}
          hint={props.hint ? t('ask.setup.keyHint', { last4: props.hint }) : t('ask.setup.keyNone')}
          onChange={(e) => setKey(e.target.value)}
        />
        <Input
          label={t('ask.setup.model')}
          value={model}
          hint={t('ask.setup.modelHint')}
          onChange={(e) => setModel(e.target.value)}
        />
        <Input
          label={t('ask.setup.cap')}
          inputMode="numeric"
          value={cap}
          onChange={(e) => setCap(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        <div className="flex items-end">
          <Button
            type="submit"
            variant="secondary"
            disabled={save.isPending || (!key && !props.hasKey)}
          >
            {t('ask.setup.save')}
          </Button>
        </div>
      </form>
      {canSwitchChannels(props.role) ? (
        <div>
          <Button
            variant="secondary"
            disabled={toggle.isPending || (!props.enabled && !props.hasKey)}
            onClick={() =>
              toggle.mutate(
                { kind: 'llm', enabled: !props.enabled },
                { onError: () => toast.show({ message: t('ask.errors.unknown'), tone: 'danger' }) },
              )
            }
          >
            {props.enabled ? t('ask.setup.turnOff') : t('ask.setup.turnOn')}
          </Button>
        </div>
      ) : (
        <p className="text-muted">{t('ask.setup.ownerOnly')}</p>
      )}
    </section>
  );
}

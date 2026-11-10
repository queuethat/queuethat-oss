import { Badge, Button, Card, Checkbox, Input, PageHeader, Select, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentOrg } from '../../../auth/current.ts';
import {
  CHANNELS,
  fieldsFor,
  MissingPrerequisites,
  PROVIDERS,
  canEditProviders,
  canSwitchChannels,
  providerSettingsQuery,
  useSaveProviderSettings,
  useSetChannelEnabled,
  webhookUrl,
  type Channel,
} from './api.ts';

interface Row {
  kind: string;
  provider: string;
  mode: string;
  config: unknown;
  secret_hints: unknown;
  endpoint_id: string;
  messaging_campaign_ref: string | null;
  verified_at: string | null;
  enabled: boolean;
}

const SAVE_ERRORS = ['platform_mode_unavailable', 'invalid_input', 'permission_denied'];

/** `/admin/integrations` (3-PV3, #342): provider credentials, webhook URL, verification and the enable switch. */
export function ProvidersPage() {
  const { t } = useTranslation('admin-integrations');
  const org = useCurrentOrg();
  const query = useQuery({ ...providerSettingsQuery(org?.id ?? ''), enabled: !!org });
  if (!org || (!query.data && !query.isError)) return <Skeleton label={t('loading')} rows={2} />;
  const editable = canEditProviders(org.role);
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('title')} description={editable ? undefined : t('readOnly')} />
      {query.isError ? <p role="alert">{t('errors.unknown')}</p> : null}
      {CHANNELS.map((channel) => (
        <ChannelCard
          key={channel}
          orgId={org.id}
          name={channel}
          role={org.role}
          row={(query.data as Row[] | undefined)?.find((r) => r.kind === channel)}
        />
      ))}
    </div>
  );
}

function ChannelCard({
  orgId,
  name: channel,
  role,
  row,
}: {
  orgId: string;
  name: Channel;
  role: string;
  row: Row | undefined;
}) {
  const { t } = useTranslation('admin-integrations');
  const editable = canEditProviders(role);
  const save = useSaveProviderSettings(orgId);
  const toggle = useSetChannelEnabled(orgId);
  const stored = {
    ...((row?.config as Record<string, string> | undefined) ?? {}),
    messaging_campaign_ref: row?.messaging_campaign_ref ?? '',
  };
  const hints = (row?.secret_hints as Record<string, string> | undefined) ?? {};
  const [provider, setProvider] = useState(row?.provider ?? PROVIDERS[channel][0]!);
  const fields = fieldsFor(channel, provider);
  const [mode, setMode] = useState(row?.mode ?? 'own');
  const [config, setConfig] = useState<Record<string, string>>(stored);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const given = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ''));
    const keep = Object.fromEntries(fields.config.map((k) => [k, config[k] ?? '']));
    save.mutate(
      { kind: channel, provider, mode, config: keep, secrets: mode === 'own' ? given : {} },
      { onSuccess: () => setSecrets({}) },
    );
  };
  const failure = save.error
    ? SAVE_ERRORS.includes(save.error.message)
      ? save.error.message
      : 'unknown'
    : null;
  const missing = toggle.error instanceof MissingPrerequisites ? toggle.error.missing : [];
  const url = row ? webhookUrl(row.provider, row.endpoint_id) : null;

  return (
    <Card className="flex flex-col gap-4" data-testid={`channel-${channel}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t(`channels.${channel}`)}</h2>
        <Badge tone={row?.enabled ? 'success' : 'neutral'}>
          {row?.enabled ? t('state.enabled') : t('state.disabled')}
        </Badge>
      </div>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Select
          label={t('provider')}
          value={provider}
          disabled={!editable}
          onChange={(e) => setProvider(e.target.value)}
        >
          {PROVIDERS[channel].map((p) => (
            <option key={p} value={p}>
              {t(`providers.${p}` as 'providers.twilio')}
            </option>
          ))}
        </Select>
        <Select
          label={t('mode.label')}
          value={mode}
          disabled={!editable}
          onChange={(e) => setMode(e.target.value)}
        >
          <option value="own">{t('mode.own')}</option>
          <option value="platform">{t('mode.platform')}</option>
        </Select>
        {fields.config.map((key) => (
          <Input
            key={key}
            label={t(`fields.${key}` as 'fields.from_number')}
            readOnly={!editable}
            value={config[key] ?? ''}
            onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
          />
        ))}
        {mode === 'own'
          ? fields.secrets.map((key) => (
              <Input
                key={key}
                type="password"
                autoComplete="off"
                label={t(`secretsBy.${provider}.${key}` as 'secrets.auth_token', {
                  defaultValue: t(`secrets.${key}` as 'secrets.auth_token'),
                })}
                hint={hints[key] ? t('secretStored', { last4: hints[key] }) : t('secretEmpty')}
                placeholder={hints[key] ? `****${hints[key]}` : ''}
                readOnly={!editable}
                value={secrets[key] ?? ''}
                onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })}
              />
            ))
          : null}
        {failure ? <p role="alert">{t(`errors.${failure}` as 'errors.unknown')}</p> : null}
        {editable ? (
          <div>
            <Button type="submit" loading={save.isPending} loadingLabel={t('saving')}>
              {t('save')}
            </Button>
          </div>
        ) : null}
      </form>
      {url ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <Input
                label={t('webhook.label')}
                readOnly
                value={url}
                className="font-mono"
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() =>
                void navigator.clipboard?.writeText(url).then(
                  () => setCopied(true),
                  () => undefined,
                )
              }
            >
              {copied ? t('webhook.copied') : t('webhook.copy')}
            </Button>
          </div>
          <p className="text-muted" data-testid={`verified-${channel}`}>
            {row?.verified_at ? t('webhook.verified') : t('webhook.waiting')}
          </p>
        </div>
      ) : null}
      {canSwitchChannels(role) && row ? (
        <div className="flex flex-col gap-2">
          <Checkbox
            label={t('enable')}
            checked={row.enabled}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate({ kind: channel, enabled: e.target.checked })}
          />
          {toggle.isError && missing.length === 0 ? (
            <p role="alert">{t('errors.unknown')}</p>
          ) : null}
          {missing.length > 0 ? (
            <div role="alert" data-testid={`missing-${channel}`}>
              <p className="font-medium">{t('missing.title')}</p>
              <ul className="list-disc pl-6">
                {missing.map((item) => (
                  <li key={item}>{t(`missing.${item}` as 'missing.compliance_gate')}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

import { errorCode, PROVIDER_FIELDS } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { appConfig } from '../../../../lib/config.ts';
import { supabase } from '../../../../lib/supabase.ts';

export const CHANNELS = ['email', 'sms', 'whatsapp', 'payments'] as const;
export type Channel = (typeof CHANNELS)[number];
/** Channels with provider settings: the four above plus `llm` (analytics questions, 4-AI1), which has its own page. */
export type SettingsChannel = Channel | 'llm';

/** Owners and admins edit credentials; only owners may switch a channel on or off. */
export const canEditProviders = (role: string | undefined) => role === 'admin' || role === 'owner';
export const canSwitchChannels = (role: string | undefined) => role === 'owner';

/** Providers an org can pick per channel: the ones that have an adapter (PROVIDER_FIELDS owns the list). */
export const PROVIDERS: Record<Channel, string[]> = {
  email: Object.keys(PROVIDER_FIELDS.email),
  sms: Object.keys(PROVIDER_FIELDS.sms),
  whatsapp: Object.keys(PROVIDER_FIELDS.whatsapp),
  payments: Object.keys(PROVIDER_FIELDS.payments),
};

/**
 * Non-secret `config` keys and write-only secret names for one provider. `messaging_campaign_ref`
 * is stored by the database in its own column.
 */
export function fieldsFor(channel: Channel, provider: string) {
  const spec = PROVIDER_FIELDS[channel][provider];
  return { config: [...(spec?.config ?? [])], secrets: [...(spec?.secrets ?? [])] };
}

const settingsKey = (orgId: string) => ['admin', 'provider-settings', orgId];

/** The org's provider settings. The Vault ids are not readable; secrets show only their last four characters. */
export const providerSettingsQuery = (orgId: string) =>
  queryOptions({
    queryKey: settingsKey(orgId),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('provider_settings')
        .select(
          'kind:channel, provider, mode, config, secret_hints, endpoint_id, messaging_campaign_ref, verified_at, enabled',
        )
        .eq('org_id', orgId);
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

/** The URL to paste into the provider's dashboard (served by the provider-webhook Edge Function). */
export const webhookUrl = (provider: string, endpointId: string) =>
  `${appConfig().supabaseUrl}/functions/v1/provider-webhook/${provider}/${endpointId}`;

/** `api.set_provider_settings`. Errors: `platform_mode_unavailable`, `invalid_input`, `permission_denied`. */
export function useSaveProviderSettings(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      kind: SettingsChannel;
      provider: string;
      mode: string;
      config: Record<string, string>;
      secrets: Record<string, string>;
    }) => {
      const { error } = await supabase.rpc('set_provider_settings', {
        p_org_id: orgId,
        p_channel: input.kind,
        p_provider: input.provider,
        p_mode: input.mode,
        p_config: input.config,
        p_secrets: input.secrets,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) {
        throw new Error(
          (error as { message?: string }).message === 'platform_mode_unavailable'
            ? 'platform_mode_unavailable'
            : errorCode(error),
        );
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKey(orgId) }),
  });
}

/** Thrown when enabling is refused; `missing` lists what the owner still has to do. */
export class MissingPrerequisites extends Error {
  constructor(readonly missing: string[]) {
    super('channel_prerequisite_missing');
  }
}

/** `api.set_channel_enabled`. Enabling may throw {@link MissingPrerequisites}. */
export function useSetChannelEnabled(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: SettingsChannel; enabled: boolean }) => {
      const { error } = await supabase.rpc('set_channel_enabled', {
        p_org_id: orgId,
        p_channel: input.kind,
        p_enabled: input.enabled,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (!error) return;
      if (errorCode(error) === 'channel_prerequisite_missing') {
        const detail = (error as { details?: string }).details ?? '';
        throw new MissingPrerequisites(detail.split(',').filter(Boolean));
      }
      throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKey(orgId) }),
  });
}

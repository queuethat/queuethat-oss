// Per-org channel resolution for the dispatcher (3-PV2, #341). Deno + browser safe.
// `createRegistry` (channel.ts) serves fixed deployment channels; this one adds the channels an org
// brings itself (own Twilio, own email account), read from `api.get_channel_config`. Secrets exist
// only in the objects a factory receives and the channel it returns: no persistence, no logging.
import type { ChannelRegistry, ChannelKind, NotificationChannel } from './channel.ts';

/** `api.channel_config` as the dispatcher sees it (service role only). */
export interface ChannelConfig {
  provider: string | null;
  mode: string | null;
  config: Record<string, unknown> | null;
  secrets: Record<string, string> | null;
  enabled: boolean;
}

/** Builds the channel for one org from its settings. Return null when the settings are unusable. */
export type ProviderFactory = (settings: {
  mode: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}) => NotificationChannel | null;

/** Channel kinds an org configures itself. The rest (push, telegram) belong to the deployment. */
export const PER_ORG_KINDS: readonly ChannelKind[] = ['email', 'sms', 'whatsapp'];

export interface DbRegistryOptions {
  /** `api.get_channel_config` through the service-role client. */
  fetchConfig(orgId: string, kind: ChannelKind): Promise<ChannelConfig | null>;
  /** provider name -> constructor. Paid adapters register here (3-EM1, 3-SMS1, 3-WA1). */
  factories: Record<string, ProviderFactory>;
  /** Console, mail catcher and the deployment's own channels. */
  local: ChannelRegistry;
  /**
   * Forces the local channels for every org. Defaults to true; only the literal 'false' of
   * LOCAL_PROVIDERS_ONLY turns real providers on, so a missing variable can't send real messages.
   */
  localOnly?: boolean;
}

/** True unless LOCAL_PROVIDERS_ONLY is exactly 'false'. */
export function localProvidersOnly(value: string | undefined): boolean {
  return value !== 'false';
}

/**
 * Resolves `get(orgId, kind)`. In local mode, or for a kind the deployment owns, that is the local
 * registry. Otherwise it is the org's enabled provider settings, looked up once per (org, kind)
 * for the life of this registry: create one per dispatcher invocation so secrets never outlive it.
 * `null` means the org has no enabled channel; `missingReason` tells the dispatcher what to record.
 */
export class DbChannelRegistry implements ChannelRegistry {
  readonly #cache = new Map<string, Promise<NotificationChannel | null>>();
  readonly #opts: DbRegistryOptions;

  constructor(opts: DbRegistryOptions) {
    this.#opts = opts;
  }

  /** A null for an org-configured kind means the org has it off; elsewhere the deployment lacks it. */
  missingReason(_orgId: string, kind: ChannelKind): 'channel_disabled' | undefined {
    return this.#opts.localOnly === false && PER_ORG_KINDS.includes(kind)
      ? 'channel_disabled'
      : undefined;
  }

  get(orgId: string, kind: ChannelKind): Promise<NotificationChannel | null> {
    if (this.#opts.localOnly !== false || !PER_ORG_KINDS.includes(kind)) {
      return this.#opts.local.get(orgId, kind);
    }
    const key = `${orgId}:${kind}`;
    let channel = this.#cache.get(key);
    if (!channel) {
      channel = this.#resolve(orgId, kind);
      this.#cache.set(key, channel);
      // a transient RPC error must not stall this org's channel for the rest of the run
      channel.catch(() => this.#cache.delete(key));
    }
    return channel;
  }

  async #resolve(orgId: string, kind: ChannelKind): Promise<NotificationChannel | null> {
    const row = await this.#opts.fetchConfig(orgId, kind);
    if (!row?.enabled || !row.provider) return null;
    const factory = this.#opts.factories[row.provider];
    if (!factory) return null;
    let channel: NotificationChannel | null;
    try {
      channel = factory({
        mode: row.mode ?? 'own',
        config: row.config ?? {},
        secrets: row.secrets ?? {},
      });
    } catch {
      // The message may quote the settings; none of it is allowed into a log.
      throw new Error(`provider_factory_failed:${row.provider}`);
    }
    return channel && channel.kind === kind ? channel : null;
  }
}

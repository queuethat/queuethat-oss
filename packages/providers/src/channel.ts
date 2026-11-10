// The one interface every outbound channel implements (technical-design.md 3.4 and 3.5,
// architecture review 6). Deno + browser safe: no imports beyond types.
import type { Database } from '@qm/db-types';
import { policyCheck, type SuppressReason } from './policy.ts';

type AppEnums = Database['app']['Enums'];

/** Channel names come from `app.notification_channel`, so TS and SQL can't drift. */
export type ChannelKind = AppEnums['notification_channel'];
export type MessageCategory = AppEnums['message_category'];
/** `notification_templates.trigger`. `called` is urgent and exempt from the send window (decided in the database). */
export type NotificationTrigger =
  | 'called'
  | 'almost_up'
  | 'help'
  | 'appointment_reminder'
  | 'appointment_confirmed'
  | 'reply_verify';

/** Same shape as `api.outbox_job.recipient`. */
export type Recipient =
  | { kind: 'push'; endpoint: string; p256dh: string; auth: string }
  | { kind: 'address'; value: string }; // E.164 phone or lower-case email

/** Decided by the database (`api.claim_outbox`); channels never look these up themselves. */
export interface PolicyInputs {
  /** Granted consent for this channel and category. A push subscription is its own opt-in. */
  hasConsent: boolean;
  /** The address is in `app.suppressions` (STOP, bounce, complaint, manual). */
  isSuppressed: boolean;
  /**
   * IANA zone of the visit's location. Informational: the send window is decided by
   * `api.claim_outbox`, not here. Null for account mail to members, which has no location.
   */
  locationTz: string | null;
}

/** One rendered notification, built by the dispatcher from an `api.outbox_job`. */
export interface OutboundMessage {
  /** `notifications.id`; also the provider idempotency key where the provider supports one. */
  outboxId: string;
  orgId: string;
  channel: ChannelKind;
  category: MessageCategory;
  trigger: NotificationTrigger;
  to: Recipient;
  subject?: string;
  text: string;
  html?: string;
  /** Deep link to the guest's status page. */
  url?: string;
  /** RFC 8058 one-click unsubscribe endpoint; email channels send it as List-Unsubscribe. */
  unsubscribeUrl?: string;
  /** WhatsApp only: the approved template to send and whether the 24 h service window is open. */
  whatsapp?: {
    template?: { name: string; language: string; params: string[] };
    windowOpen: boolean;
  };
  policy: PolicyInputs;
}

/**
 * Outcome of one send. `status` matches what `api.report_outbox_result` records:
 * - `sent`: accepted by the provider.
 * - `failed`: not sent; the dispatcher retries only when `retryable`.
 * - `gone`: the recipient no longer exists (push 404/410); delete it, never retry.
 * - `suppressed`: policy forbade sending; nothing left the process.
 */
export type SendResult =
  | { status: 'sent'; providerMessageId?: string; segments?: number; costMicros?: number }
  | { status: 'failed'; retryable: boolean; code: string; message: string }
  | { status: 'gone'; code: string; message: string }
  | { status: 'suppressed'; reason: SuppressReason };

/** A delivery report pushed back by a provider (SMS/WhatsApp, phase 3). */
export interface StatusUpdate {
  providerMessageId: string;
  status: 'delivered' | 'failed' | 'undelivered';
  at: string;
}

/** An inbound reply such as STOP or HELP (phase 3). */
export interface InboundMessage {
  from: string;
  text: string;
  providerMessageId: string;
}

export interface NotificationChannel {
  readonly kind: ChannelKind;
  /** Recorded in `notifications.provider`: 'console', 'mailpit', 'vapid', 'twilio'... */
  readonly providerName: string;
  /** Expected segments and cost, without sending. Used for caps before the send. */
  estimate(msg: OutboundMessage): { segments?: number; costMicros?: number };
  /**
   * Sends `msg` unless consent or suppression forbid it, in which case it returns
   * `suppressed` and nothing is delivered. Never throws: provider errors come back as `failed`.
   */
  send(msg: OutboundMessage): Promise<SendResult>;
  parseStatusCallback?(req: Request): Promise<StatusUpdate[]>;
  parseInbound?(req: Request): Promise<InboundMessage[]>;
}

/** Picks the channel for an org. Per-org providers (bring-your-own Twilio) slot in here later. */
export interface ChannelRegistry {
  get(orgId: string, kind: ChannelKind): Promise<NotificationChannel | null>;
  /**
   * For registries where a null can mean the org turned the channel off (DbChannelRegistry): the
   * dispatcher then suppresses the row with this reason instead of dead-lettering it as no_channel.
   * Undefined means a null is a deployment without that channel.
   */
  missingReason?(orgId: string, kind: ChannelKind): 'channel_disabled' | undefined;
}

/** What a provider implements. `deliver` only runs after the policy allowed the message. */
export interface ChannelImpl {
  kind: ChannelKind;
  providerName: string;
  estimate?(msg: OutboundMessage): { segments?: number; costMicros?: number };
  deliver(msg: OutboundMessage): Promise<Exclude<SendResult, { status: 'suppressed' }>>;
  parseStatusCallback?(req: Request): Promise<StatusUpdate[]>;
  parseInbound?(req: Request): Promise<InboundMessage[]>;
}

/**
 * Builds a NotificationChannel from a provider implementation. Every channel gets the same
 * policy check and error handling, so no provider can skip consent or suppression.
 */
export function defineChannel(impl: ChannelImpl): NotificationChannel {
  const { deliver, estimate, ...rest } = impl;
  return {
    ...rest,
    estimate: estimate ?? (() => ({ costMicros: 0 })),
    async send(msg) {
      if (msg.channel !== impl.kind) {
        return failed(
          false,
          'wrong_channel',
          `${impl.providerName} sends ${impl.kind}, not ${msg.channel}`,
        );
      }
      const reason = policyCheck(msg);
      if (reason) return { status: 'suppressed', reason };
      try {
        return await deliver(msg);
      } catch (err) {
        return failed(true, 'provider_exception', String(err));
      }
    },
  };
}

/** A registry over a fixed set of channels, at most one per kind. */
export function createRegistry(channels: NotificationChannel[]): ChannelRegistry {
  const byKind = new Map<ChannelKind, NotificationChannel>();
  for (const channel of channels) {
    if (byKind.has(channel.kind)) throw new Error(`Two channels registered for ${channel.kind}`);
    byKind.set(channel.kind, channel);
  }
  return { get: async (_orgId, kind) => byKind.get(kind) ?? null };
}

export function failed(
  retryable: boolean,
  code: string,
  message: string,
): Extract<SendResult, { status: 'failed' }> {
  return { status: 'failed', retryable, code, message };
}

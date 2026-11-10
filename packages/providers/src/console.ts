// Local stand-in for any channel: "sends" by writing a row to app.dev_inbox (later V-3's fake
// inbox). Register it as `sms` or `whatsapp` in dev to exercise those paths without a provider.
import type { Database } from '@qm/db-types';
import { type ChannelKind, defineChannel, type NotificationChannel } from './channel.ts';

export type DevInboxRow = Database['app']['Tables']['dev_inbox']['Insert'];

export interface ConsoleChannelOptions {
  /** Inserts one dev_inbox row; the dispatcher passes a service-role insert. */
  write(row: DevInboxRow): Promise<void>;
  /** Channel this stands in for. Default 'console'. */
  kind?: ChannelKind;
  /**
   * Counts an SMS body (packages/domain `smsSegments`). Injected so this package stays free of
   * runtime imports; when set, the row records the encoding and the segment count a real
   * provider would bill, and the result reports the segments.
   */
  segments?(text: string): { encoding: 'gsm7' | 'ucs2'; segments: number };
}

/** A free channel that delivers into app.dev_inbox and costs nothing. */
export function consoleChannel({
  write,
  kind = 'console',
  segments,
}: ConsoleChannelOptions): NotificationChannel {
  return defineChannel({
    kind,
    providerName: 'console',
    async deliver(msg) {
      const body = msg.url ? `${msg.text}\n${msg.url}` : msg.text;
      const counted = segments?.(body);
      await write({
        org_id: msg.orgId,
        notification_id: msg.outboxId,
        channel: kind,
        recipient: msg.to.kind === 'address' ? msg.to.value : msg.to.endpoint,
        subject: msg.subject ?? null,
        body,
        ...(counted && { encoding: counted.encoding, segments: counted.segments }),
      });
      return {
        status: 'sent',
        providerMessageId: `console:${msg.outboxId}`,
        costMicros: 0,
        ...(counted && { segments: counted.segments }),
      };
    },
  });
}

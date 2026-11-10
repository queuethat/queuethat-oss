// Meta WhatsApp Cloud API webhook -> api.process_inbound_message (replies) and api.apply_delivery_status
// (receipts). The signature is already verified (verify/meta.ts); what remains is that the payload is
// for this endpoint's org: metadata.phone_number_id must be the one the org configured, else nothing
// is written. One call handles one event key (a message id, or `status.id:status.status`).
import type { WebhookHandler } from '../handler.ts';
import type { ApplyDeliveryStatus } from './twilio-status.ts';
import type { InboundMessage } from './twilio.ts';

export interface MetaHandlerDeps {
  processInbound(m: InboundMessage): Promise<unknown>;
  applyStatus: ApplyDeliveryStatus;
  /** The phone_number_id in the org's enabled whatsapp config, or null. */
  phoneNumberId(orgId: string): Promise<string | null>;
  log?(message: string): void;
}

// deno-lint-ignore no-explicit-any
type Json = any;

/** Meta's status values mapped to ours (api.apply_delivery_status); anything else is ignored. */
const STATUS: Record<string, string> = { sent: 'sent', delivered: 'delivered', read: 'delivered', failed: 'failed' };

export function createMetaHandler(deps: MetaHandlerDeps): WebhookHandler {
  const log = deps.log ?? (() => {});
  return async (ctx) => {
    if (!ctx.orgId) return;
    let body: Json;
    try {
      body = JSON.parse(new TextDecoder().decode(ctx.rawBody));
    } catch {
      return;
    }
    let expected: string | null | undefined;
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        const messages = (value?.messages ?? []).filter((m: Json) => m?.id === ctx.eventKey);
        const statuses = (value?.statuses ?? []).filter((s: Json) => `${s?.id}:${s?.status}` === ctx.eventKey);
        if (messages.length === 0 && statuses.length === 0) continue;
        expected ??= await deps.phoneNumberId(ctx.orgId);
        if (!expected || value?.metadata?.phone_number_id !== expected) {
          log(`meta webhook ${ctx.eventKey}: phone_number_id does not belong to the endpoint's org; ignored`);
          return;
        }
        for (const m of messages) {
          // Media, location and the rest are not handled yet; the event is still recorded.
          if (m.type !== 'text' || typeof m.text?.body !== 'string' || typeof m.from !== 'string') {
            log(`meta webhook ${ctx.eventKey}: unhandled message type ${String(m.type)}`);
            continue;
          }
          await deps.processInbound({
            orgId: ctx.orgId,
            channel: 'whatsapp',
            from: `+${m.from}`,
            to: `+${String(value.metadata.display_phone_number ?? '')}`,
            body: m.text.body,
            provider: 'meta',
            providerMessageId: m.id,
          });
        }
        for (const s of statuses) {
          const status = STATUS[s.status];
          if (!status) continue;
          const code = s.errors?.[0]?.code;
          await deps.applyStatus(ctx.orgId, 'meta', s.id, status, code ? `whatsapp_${code}` : undefined);
        }
      }
    }
  };
}

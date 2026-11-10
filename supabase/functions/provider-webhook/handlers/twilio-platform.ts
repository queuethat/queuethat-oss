// Platform Twilio number (#1089): the webhook route has no org, so events go to one service-role
// function. Status callbacks update the owning org's message; Advanced Opt-Out inbound requests
// (OptOutType STOP/START) are sender-level and apply to every org that sends through the platform.
// A whole-message YES (Twilio may also report it as an opt-in START) confirms a staff-typed number.
// HELP is answered by Twilio itself. A free-text opt-out ("stop texting me", "no más"; compliance review M6)
// that Twilio did not flag is applied as a STOP and answered in the HTTP response, because Twilio only
// confirms its own keywords. Any other guest text is ignored: replies like L or C cannot be routed to an
// org from a shared number.
import { classifyKeyword, classifyOptOutPhrase } from '@qm/domain';
import type { WebhookHandler } from '../handler.ts';

/** api.apply_platform_sms_event */
export type PlatformSmsEvent = (e: {
  kind: 'status' | 'stop' | 'start' | 'confirm';
  phone?: string;
  providerMessageId?: string;
  status?: string;
  errorCode?: string;
}) => Promise<unknown>;

const STATUS: Record<string, string> = {
  accepted: 'queued', scheduled: 'queued', queued: 'queued', sending: 'queued', sent: 'sent',
  delivered: 'delivered', read: 'delivered', undelivered: 'undelivered', failed: 'failed',
};

/** The confirmation Twilio sends for its own STOP keywords, for the free-text opt-outs it does not recognise. */
const STOP_CONFIRMATION = {
  en: 'QueueThat: You have been unsubscribed and will get no more texts from this number. Reply START to resubscribe.',
  es: 'QueueThat: Te dimos de baja y no recibirás más mensajes de este número. Responde START para volver a suscribirte.',
} as const;

/** TwiML for the reply (the verifier's failureReply is the empty one every other event gets). */
const twiml = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

const stopReply = (language: keyof typeof STOP_CONFIRMATION) => ({
  body: twiml(`<Message>${STOP_CONFIRMATION[language]}</Message>`),
  contentType: 'text/xml',
});

export function twilioPlatformHandler(apply: PlatformSmsEvent): WebhookHandler {
  return async ({ form, isDuplicate }) => {
    if (!form) return;
    // A replayed request (a late Twilio retry, or a captured signed one) is answered again but never applied again:
    // it must not re-suppress a number the guest has since restarted.
    if (isDuplicate) {
      const language = (form.get('OptOutType') ?? '') ? null : classifyOptOutPhrase(form.get('Body') ?? '');
      return language ? stopReply(language) : undefined;
    }
    const sid = form.get('MessageSid') ?? form.get('SmsSid');
    const status = STATUS[(form.get('MessageStatus') ?? '').toLowerCase()];
    if (status && sid) {
      const code = form.get('ErrorCode');
      await apply({ kind: 'status', providerMessageId: sid, status, ...(code && { errorCode: `twilio_${code}` }) });
      return;
    }
    const optOut = (form.get('OptOutType') ?? '').toUpperCase();
    if (optOut === 'STOP' || optOut === 'START') {
      await apply({ kind: optOut === 'STOP' ? 'stop' : 'start', phone: form.get('From') ?? '' });
    } else if (!optOut) {
      const language = classifyOptOutPhrase(form.get('Body') ?? '');
      if (classifyKeyword(form.get('Body') ?? '') === 'optin') {
        // Twilio never saw our free-text stop, so it will not flag the START that answers our reply.
        await apply({ kind: 'start', phone: form.get('From') ?? '' });
      } else if (language) {
        await apply({ kind: 'stop', phone: form.get('From') ?? '' });
        return stopReply(language);
      }
    }
    if (/^(yes|y|si|sí)[.!\s]*$/i.test((form.get('Body') ?? '').trim())) {
      await apply({ kind: 'confirm', phone: form.get('From') ?? '' });
    }
  };
}

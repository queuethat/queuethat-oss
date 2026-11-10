// WhatsApp Business Cloud API channel (N-6). Bring-your-own WABA: the org's phone_number_id and
// permanent access token arrive from the provider settings (Vault), never from the bundle.
import {
  defineChannel,
  failed,
  type NotificationChannel,
  type OutboundMessage,
} from '../channel.ts';

/** Pinned so a Meta default-version bump can't change behaviour under us. */
export const WHATSAPP_GRAPH_VERSION = 'v21.0';

export interface WhatsAppCloudOptions {
  phoneNumberId: string;
  /** Permanent system-user token. */
  accessToken: string;
  graphVersion?: string;
  /** Graph origin; tests and local fakes override it. */
  apiBase?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface GraphError {
  error?: { code?: number; message?: string; error_data?: { details?: string } };
}

const MAX_TEXT = 4096;

function body(msg: OutboundMessage, to: string) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  const wa = msg.whatsapp;
  // Inside the 24 h window free text is allowed; outside it only an approved template is.
  if (wa?.template && !wa.windowOpen) {
    return {
      ...base,
      type: 'template',
      template: {
        name: wa.template.name,
        language: { code: wa.template.language },
        components: wa.template.params.length
          ? [
              {
                type: 'body',
                parameters: wa.template.params.map((text) => ({ type: 'text', text })),
              },
            ]
          : [],
      },
    };
  }
  const text = msg.url ? `${msg.text}\n${msg.url}` : msg.text;
  return { ...base, type: 'text', text: { body: text.slice(0, MAX_TEXT), preview_url: !!msg.url } };
}

/** Sends template messages, or session text while the customer service window is open. */
export function whatsappCloudChannel({
  phoneNumberId,
  accessToken,
  graphVersion = WHATSAPP_GRAPH_VERSION,
  apiBase = 'https://graph.facebook.com',
  fetch: doFetch = fetch,
}: WhatsAppCloudOptions): NotificationChannel {
  // These land in the URL and the Authorization header, so reject anything odd up front.
  if (!accessToken) throw new Error('whatsapp: accessToken is required');
  if (!/^\d+$/.test(phoneNumberId)) throw new Error('whatsapp: phoneNumberId must be numeric');
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error('whatsapp: bad graphVersion');
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(apiBase))
    throw new Error('whatsapp: apiBase must be https');
  return defineChannel({
    kind: 'whatsapp',
    providerName: 'whatsapp-cloud',
    async deliver(msg) {
      // Cloud API wants the E.164 number without the plus sign.
      const to = msg.to.kind === 'address' ? msg.to.value.replace(/^\+/, '') : '';
      if (!/^\d{6,15}$/.test(to))
        return failed(false, 'unsupported_recipient', 'whatsapp needs an E.164 phone number');
      let res: Response;
      try {
        res = await doFetch(`${apiBase}/${graphVersion}/${phoneNumberId}/messages`, {
          method: 'POST',
          signal: AbortSignal.timeout(20_000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body(msg, to)),
        });
      } catch (err) {
        return failed(true, 'network_error', String(err).replaceAll(accessToken, '***'));
      }
      const json = (await res.json().catch(() => ({}))) as GraphError & {
        messages?: Array<{ id?: string }>;
      };
      if (res.ok) {
        return { status: 'sent', providerMessageId: json.messages?.[0]?.id ?? '', costMicros: 0 };
      }
      const code = json.error?.code;
      // Meta echoes the recipient in some messages; contact data stays out of logs (I-13).
      const message = (json.error?.error_data?.details ?? json.error?.message ?? '')
        .replace(/\+?\d{6,}/g, '[number]')
        .slice(0, 200);
      if (code === 131047) return failed(false, 'outside_window', message);
      if (code === 131026) return failed(false, 'undeliverable', message);
      if (code === 130429 || res.status === 429) return failed(true, 'rate_limited', message);
      if (code === 190) return failed(false, 'auth_error', message);
      return failed(res.status >= 500, `http_${res.status}`, `${code ?? ''} ${message}`.trim());
    },
  });
}

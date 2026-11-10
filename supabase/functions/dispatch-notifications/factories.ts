// #920: the provider constructors the dispatcher's DbChannelRegistry calls, one per provider name in
// PROVIDER_FIELDS. Each reads only the keys that spec lists. Settings that can't build a channel
// (a missing field, a constructor that refuses a value) resolve to no channel, not a throw: a throw
// would leave the outbox row leased and claimed again every run, while no channel ends it as
// `suppressed: channel_disabled`. Mode `platform` has no org credentials: it uses the deployment's own
// Twilio sender (FactoryOptions.platformTwilio) and resolves to none when the deployment has none.
//
// Relative imports, not '@qm/*': the e2e specs load this file in Node, which has no workspace link.
import { PROVIDER_FIELDS } from '../../../packages/domain/src/provider-fields.ts';
import { smsSegments } from '../../../packages/domain/src/sms-segments.ts';
import type { NotificationChannel, OutboundMessage, ProviderFactory } from '../../../packages/providers/src/index.ts';
import { postmarkEmailChannel } from '../../../packages/providers/src/email/postmark.ts';
import { resendEmailChannel } from '../../../packages/providers/src/email/resend.ts';
import { plivoChannel } from '../../../packages/providers/src/sms/plivo.ts';
import { telnyxChannel } from '../../../packages/providers/src/sms/telnyx.ts';
import { twilioChannel } from '../../../packages/providers/src/sms/twilio.ts';
import { vonageChannel } from '../../../packages/providers/src/sms/vonage.ts';
import { whatsappCloudChannel } from '../../../packages/providers/src/whatsapp/cloud.ts';

export interface FactoryOptions {
  /**
   * The functions gateway (PUBLIC_FUNCTIONS_URL), where providers post delivery reports. Without
   * an https one, reports are not requested. Never taken from org settings.
   */
  functionsUrl?: string;
  /**
   * Provider API origins for local fakes. Deployment-controlled only: an org's settings must never
   * reach this (it would let an org point the dispatcher at any host).
   */
  apiBase?: Partial<Record<string, string>>;
  fetch?: typeof fetch;
  /**
   * The deployment's own Twilio sender, used for orgs in mode `platform` (TWILIO_PLATFORM_* secrets).
   * Absent, `platform` resolves to no channel and sends end as `suppressed: channel_disabled`.
   */
  platformTwilio?: {
    accountSid: string;
    apiKeySid?: string;
    /** The API key's secret, or the account auth token when no key is given. */
    authToken: string;
    messagingServiceSid: string;
    /** TWILIO_PLATFORM_WEBHOOK_ENDPOINT: the route delivery reports are posted to (with functionsUrl). */
    webhookEndpoint?: string;
  };
}

/**
 * The platform sender from TWILIO_PLATFORM_ACCOUNT_SID, TWILIO_PLATFORM_AUTH_TOKEN (an API key's
 * secret when TWILIO_PLATFORM_API_KEY_SID is set) and TWILIO_PLATFORM_MESSAGING_SERVICE_SID.
 * Undefined unless all required ones are present.
 */
export function platformTwilioFromEnv(get: (key: string) => string | undefined): FactoryOptions['platformTwilio'] {
  const v = (k: string) => (get(`TWILIO_PLATFORM_${k}`) ?? '').trim();
  const [accountSid, authToken, messagingServiceSid, apiKeySid] = [v('ACCOUNT_SID'), v('AUTH_TOKEN'), v('MESSAGING_SERVICE_SID'), v('API_KEY_SID')];
  if (!accountSid || !authToken || !messagingServiceSid) return undefined;
  const webhookEndpoint = v('WEBHOOK_ENDPOINT');
  return { accountSid, authToken, messagingServiceSid, ...(apiKeySid && { apiKeySid }), ...(webhookEndpoint && { webhookEndpoint }) };
}

type Settings = Parameters<ProviderFactory>[0];

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The platform's toll-free sender is shared by every business, and a business can rewrite its SMS
 * templates and send free-text broadcasts. A message without opt-out wording gets filtered by
 * carriers and can cost the shared number its verification for all tenants (and breaks CASL/TCPA),
 * so the opt-out line is added when the text carries none.
 */
export const PLATFORM_SMS_STOP_LINE = 'Reply STOP to opt out.';
// "stop" alone is not an opt-out line ("Bus stop café", a guest named Stop): it needs a verb or "to".
const OPT_OUT_WORDING = /\b(?:(?:reply|respond|text|txt|send|responde|env[ií]a)\s+(?:with\s+)?"?STOP|STOP\s+to)\b/i;
export function withStopLine(body: string): string {
  return OPT_OUT_WORDING.test(body) ? body : `${body.trimEnd()} ${PLATFORM_SMS_STOP_LINE}`;
}

/** Wraps a builder so unusable settings give null instead of an exception that could echo them. */
function guarded(
  channel: 'email' | 'sms' | 'whatsapp',
  provider: string,
  build: (get: (key: string) => string, s: Settings) => NotificationChannel,
  platformBuild?: (s: Settings) => NotificationChannel | null,
): ProviderFactory {
  const spec = PROVIDER_FIELDS[channel][provider]!;
  return (settings) => {
    if (settings.mode === 'platform') return platformBuild?.(settings) ?? null;
    if (settings.mode !== 'own') return null;
    const get = (key: string) =>
      text(spec.secrets.includes(key) ? settings.secrets[key] : settings.config[key]);
    if (spec.required.some((key) => get(key) === '')) return null;
    // a display name or address that could smuggle a second address into From
    if (channel === 'email' && (!/^[^\s<>,;"]+@[^\s<>,;"]+$/.test(get('sender_email')) || /[<>"\r\n]/.test(get('sender_name')))) {
      return null;
    }
    try {
      return build(get, settings);
    } catch {
      return null;
    }
  };
}

/** Provider name -> constructor for every provider with an adapter. */
export function providerFactories(opts: FactoryOptions = {}): Record<string, ProviderFactory> {
  const base = opts.apiBase ?? {};
  const common = (name: string) => ({
    ...(base[name] && { apiBase: base[name] }),
    ...(opts.fetch && { fetch: opts.fetch }),
  });
  const emailCommon = (name: string, get: (key: string) => string) => ({
    apiKey: get('api_key'),
    from: { email: get('sender_email'), ...(get('sender_name') && { name: get('sender_name') }) },
    ...(base[name] && { baseUrl: base[name] }),
    ...(opts.fetch && { fetch: opts.fetch }),
  });
  // `{functions}/provider-webhook/{provider}/{endpoint}`: what the webhook URL on the settings page shows.
  const reportUrl = (provider: string, s: Settings): string | undefined => {
    const endpoint = text(s.config.endpoint_id);
    if (!opts.functionsUrl || !/^[0-9a-f-]{36}$/i.test(endpoint)) return undefined;
    const url = `${opts.functionsUrl.replace(/\/+$/, '')}/provider-webhook/${provider}/${endpoint}`;
    return url.startsWith('https://') ? url : undefined;
  };

  // `{functions}/provider-webhook/twilio-platform/{endpoint}`: one deployment-wide route, no org in it.
  const platformReportUrl = (endpoint: string | undefined): string | undefined => {
    if (!opts.functionsUrl || !endpoint || !/^[0-9a-f-]{36}$/i.test(endpoint)) return undefined;
    const url = `${opts.functionsUrl.replace(/\/+$/, '')}/provider-webhook/twilio-platform/${endpoint}`;
    return url.startsWith('https://') ? url : undefined;
  };

  return {
    twilio: guarded('sms', 'twilio', (get, s) =>
      twilioChannel({
        accountSid: get('account_sid'),
        authToken: get('auth_token'),
        messagingServiceSid: get('messaging_service_sid'),
        statusCallbackUrl: reportUrl('twilio', s),
        segments: smsSegments,
        ...common('twilio'),
      }),
      (s) => {
        const p = opts.platformTwilio;
        if (!p) return null;
        try {
          const inner = twilioChannel({
            accountSid: p.accountSid,
            ...(p.apiKeySid && { apiKeySid: p.apiKeySid }),
            authToken: p.authToken,
            messagingServiceSid: p.messagingServiceSid,
            statusCallbackUrl: platformReportUrl(p.webhookEndpoint),
            segments: smsSegments,
            ...common('twilio'),
          });
          const stop = (m: OutboundMessage): OutboundMessage => ({ ...m, text: withStopLine(m.text) });
          return {
            ...inner,
            estimate: (m) => inner.estimate(stop(m)),
            send: (m) => inner.send(stop(m)),
          };
        } catch {
          return null;
        }
      }),
    telnyx: guarded('sms', 'telnyx', (get, s) =>
      telnyxChannel({
        apiKey: get('api_key'),
        messagingProfileId: get('messaging_profile_id'),
        webhookUrl: reportUrl('telnyx', s),
        segments: smsSegments,
        ...common('telnyx'),
      })),
    vonage: guarded('sms', 'vonage', (get, s) =>
      vonageChannel({
        apiKey: get('api_key'),
        apiSecret: get('api_secret'),
        from: get('from_number'),
        statusUrl: reportUrl('vonage', s),
        segments: smsSegments,
        ...common('vonage'),
      })),
    plivo: guarded('sms', 'plivo', (get, s) =>
      plivoChannel({
        authId: get('auth_id'),
        authToken: get('auth_token'),
        from: get('from_number'),
        statusUrl: reportUrl('plivo', s),
        segments: smsSegments,
        ...common('plivo'),
      })),
    postmark: guarded('email', 'postmark', (get) =>
      postmarkEmailChannel({
        ...emailCommon('postmark', get),
        ...(get('message_stream') && { messageStream: get('message_stream') }),
      })),
    resend: guarded('email', 'resend', (get) => resendEmailChannel(emailCommon('resend', get))),
    meta: guarded('whatsapp', 'meta', (get) =>
      whatsappCloudChannel({
        phoneNumberId: get('phone_number_id'),
        accessToken: get('access_token'),
        ...common('meta'),
      })),
  };
}

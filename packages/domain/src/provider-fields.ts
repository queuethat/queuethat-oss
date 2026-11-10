/**
 * What each messaging provider needs from an org (#921). One owner for the key names: the
 * `/admin/integrations` form renders them and the dispatcher's provider factories read them, so
 * the two cannot drift. `config` keys are stored in clear (`app.provider_settings.config`);
 * `secrets` go to Vault and are write-only.
 *
 * Secret names are chosen so `api.get_webhook_secret` finds the webhook signing secret by name
 * (`auth_token`, `signing_secret`, `webhook_secret` or `app_secret`): Telnyx's webhook public key
 * is `webhook_secret`, Vonage's signature secret is `signing_secret`, Plivo and Twilio sign with
 * their `auth_token`. Credentials that only sign outbound API calls (`api_key`, `api_secret`) stay
 * out of that set, so a webhook endpoint can never be asked to verify against them.
 */
export interface ProviderFields {
  /** Non-secret settings. */
  config: readonly string[];
  /** Write-only credentials. */
  secrets: readonly string[];
  /** Keys that must be set before the provider can send. The rest are optional. */
  required: readonly string[];
}

export type MessagingChannel = 'email' | 'sms' | 'whatsapp' | 'payments';

export const PROVIDER_FIELDS: Record<MessagingChannel, Record<string, ProviderFields>> = {
  email: {
    postmark: {
      config: ['sender_email', 'sender_name', 'message_stream'],
      secrets: ['api_key', 'webhook_secret'],
      required: ['sender_email', 'api_key'],
    },
    resend: {
      config: ['sender_email', 'sender_name'],
      secrets: ['api_key', 'webhook_secret'],
      required: ['sender_email', 'api_key'],
    },
  },
  sms: {
    twilio: {
      config: ['account_sid', 'messaging_service_sid', 'from_number', 'messaging_campaign_ref'],
      secrets: ['auth_token'],
      required: ['account_sid', 'messaging_service_sid', 'auth_token'],
    },
    telnyx: {
      config: ['messaging_profile_id', 'from_number', 'messaging_campaign_ref'],
      secrets: ['api_key', 'webhook_secret'],
      required: ['messaging_profile_id', 'api_key'],
    },
    vonage: {
      config: ['from_number', 'messaging_campaign_ref'],
      secrets: ['api_key', 'api_secret', 'signing_secret'],
      required: ['from_number', 'api_key', 'api_secret'],
    },
    plivo: {
      config: ['auth_id', 'from_number', 'messaging_campaign_ref'],
      secrets: ['auth_token'],
      required: ['auth_id', 'from_number', 'auth_token'],
    },
  },
  whatsapp: {
    meta: {
      config: ['phone_number_id'],
      secrets: ['access_token', 'app_secret', 'verify_token'],
      required: ['phone_number_id', 'access_token'],
    },
  },
  payments: {
    stripe: { config: [], secrets: ['secret_key', 'webhook_secret'], required: ['secret_key'] },
  },
};

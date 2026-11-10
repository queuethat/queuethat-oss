// provider-webhook entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { supabaseDeps } from './deps.ts';
import { createObserver } from '../_shared/observe.ts';
import { createProviderWebhookHandler } from './handler.ts';
import { createMetaHandler } from './handlers/meta.ts';
import { type ApplyDeliveryStatus, twilioStatusHandler } from './handlers/twilio-status.ts';
import { createPlivoHandler } from './handlers/plivo.ts';
import { postmarkHandler, resendHandler } from './handlers/email.ts';
import { squareHandler } from './handlers/square.ts';
import { stripePaymentHandler } from './handlers/stripe.ts';
import { createTelnyxHandler } from './handlers/telnyx.ts';
import { createVonageHandler } from './handlers/vonage.ts';
import { createTwilioInboundHandler } from './handlers/twilio.ts';
import { twilioPlatformHandler } from './handlers/twilio-platform.ts';
import { createTwilioVoiceHandler } from './handlers/twilio-voice.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('provider-webhook', Deno.env.get('SENTRY_DSN'));
const api = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('api');

const db = supabaseDeps(createClient, {
  url: env('SUPABASE_URL'),
  serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
});

const twilioInbound = createTwilioInboundHandler(db.processInbound);
const applyStatus: ApplyDeliveryStatus = async (orgId, provider, sid, status, errorCode) => {
  const { data, error } = await api.rpc('apply_delivery_status', {
    p_org_id: orgId, p_provider: provider, p_provider_message_id: sid, p_status: status,
    p_error_code: errorCode ?? null,
  });
  if (error) throw new Error(error.message);
  return data === true;
};
const twilioStatus = twilioStatusHandler(applyStatus);
const twilioVoice = createTwilioVoiceHandler(async (c) => {
  const { data, error } = await api.rpc('process_voice_call', {
    p_org_id: c.orgId, p_call_sid: c.callSid, p_from: c.from, p_step: c.step, p_digits: c.digits,
    p_visit_id: c.visitId, p_verified: c.verified,
  });
  if (error) throw new Error(error.message);
  return data;
});
const twilioPlatform = twilioPlatformHandler(async (e) => {
  const { error } = await api.rpc('apply_platform_sms_event', {
    p_kind: e.kind, p_phone: e.phone ?? null, p_provider_message_id: e.providerMessageId ?? null,
    p_status: e.status ?? null, p_error_code: e.errorCode ?? null,
  });
  if (error) throw new Error(error.message);
});
// The platform number has no org row: its one route and signing token come from the environment.
const platformEndpoint = Deno.env.get('TWILIO_PLATFORM_WEBHOOK_ENDPOINT') ?? '';
const platformToken = Deno.env.get('TWILIO_PLATFORM_WEBHOOK_TOKEN') ?? '';
const meta = createMetaHandler({ ...db, applyStatus, log: observe.log });

const stripePayments = stripePaymentHandler(async (a) => {
  const { data, error } = await api.rpc('apply_payment_event', {
    p_org_id: a.orgId, p_provider: 'stripe', p_type: a.type, p_object_id: a.objectId, p_meta_org: a.metaOrg,
    p_amount_minor: a.amountMinor, p_customer_id: a.customerId, p_payment_method_id: a.paymentMethodId,
  });
  if (error) throw new Error(error.message);
  return String(data);
}, observe.log);

const square = squareHandler(async (orgId, merchantId) => {
  const { error } = await api.rpc('revoke_integration', { p_org_id: orgId, p_channel: 'pos', p_merchant_id: merchantId });
  if (error) throw new Error(error.message);
});

const suppressByMessage = async (orgId: string, provider: string, sid: string, reason: 'bounce' | 'complaint') => {
  const { data, error } = await api.rpc('suppress_by_message', {
    p_org_id: orgId, p_provider: provider, p_provider_message_id: sid, p_reason: reason,
  });
  if (error) throw new Error(error.message);
  return data === true;
};

Deno.serve(
  observe.serve(createProviderWebhookHandler({
    endpointSecrets: (provider, endpointId) =>
      provider === 'twilio-platform'
        ? Promise.resolve(platformToken && endpointId === platformEndpoint ? { orgId: null, secrets: [platformToken] } : null)
        : db.endpointSecrets(provider, endpointId),
    record: db.record,
    markProcessed: db.markProcessed,
    // WhatsApp handlers register here as 3-WA3 lands. A Twilio request is
    // either a status callback (MessageStatus) or a guest's text; each handler ignores the other.
    handlers: {
      resend: resendHandler(applyStatus, suppressByMessage),
      postmark: postmarkHandler(applyStatus, suppressByMessage),
      telnyx: createTelnyxHandler(applyStatus, db.processInbound),
      vonage: createVonageHandler(applyStatus, db.processInbound),
      plivo: createPlivoHandler(applyStatus, db.processInbound),
      twilio: async (ctx) => {
        await twilioStatus(ctx);
        await twilioInbound(ctx);
      },
      'twilio-platform': twilioPlatform,
      'twilio-voice': twilioVoice,
      meta,
      stripe: stripePayments,
      square,
    },
    publicFunctionsUrl: Deno.env.get('PUBLIC_FUNCTIONS_URL') ?? `${env('SUPABASE_URL')}/functions/v1`,
    log: observe.log,
    error: observe.error,
  })),
);

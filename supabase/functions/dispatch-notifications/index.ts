// N3 (#69): dispatch-notifications entry point. The logic and its contract are in handler.ts.
// An Edge Function because sending needs secrets and outbound I/O (technical-design.md 3.5, rule 3).
import { createClient } from '@supabase/supabase-js';
import {
  consoleChannel,
  createRegistry,
  DbChannelRegistry,
  localProvidersOnly,
  mailpitEmailChannel,
  telegramChannel,
  type ChannelConfig,
  type NotificationChannel,
  vapidWebPushChannel,
} from '@qm/providers';
import { smsSegments } from '@qm/domain';
import { vapidFromEnv, webPushTransport } from '../_shared/web-push.ts';
import { createObserver } from '../_shared/observe.ts';
import { providerFactories } from './factories.ts';
import { appOrigin, createDispatchHandler, oneClickEndpoint, type OutboxJob, type WhatsAppSend } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const api = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('api');

// Phase 1 channels. Email goes to the local mail catcher when MAILPIT_URL is set; a real email
// provider registers here. Web push needs the VAPID secrets (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT). A kind with no channel is dead-lettered as no_channel.
const channels: NotificationChannel[] = [];
const mailpit = Deno.env.get('MAILPIT_URL');
if (mailpit) {
  channels.push(
    mailpitEmailChannel({
      baseUrl: mailpit,
      from: { email: Deno.env.get('NOTIFY_FROM_EMAIL') ?? 'queue@localhost', name: 'QueueThat' },
    }),
  );
}

if (Deno.env.get('VAPID_PRIVATE_KEY')) {
  channels.push(vapidWebPushChannel({ transport: webPushTransport(vapidFromEnv()) }));
}

// Telegram is free: one bot per deployment. Without the token the channel is simply unavailable
// (rows for it dead-letter as no_channel), which is not an error.
const telegramToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
if (telegramToken) channels.push(telegramChannel({ botToken: telegramToken }));

// Local SMS stand-in: "sends" into app.dev_inbox with the segment count a provider would bill.
// Off unless DEV_SMS_CONSOLE=true, so a deployment without a real SMS provider keeps dead-lettering
// SMS as no_channel instead of pretending to deliver it.
if (Deno.env.get('DEV_SMS_CONSOLE') === 'true') {
  const app = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  }).schema('app');
  channels.push(consoleChannel({
    kind: 'sms',
    segments: smsSegments,
    async write(row) {
      const { error } = await app.from('dev_inbox').insert(row);
      if (error) throw new Error(error.message);
    },
  }));
}

// Where providers post delivery reports. The same value provider-webhook verifies signatures against.
const functionsUrl = Deno.env.get('PUBLIC_FUNCTIONS_URL') ?? `${env('SUPABASE_URL')}/functions/v1`;

const observe = createObserver('dispatch-notifications', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createDispatchHandler({
    async claim(limit, leaseSeconds) {
      const { data, error } = await api.rpc('claim_outbox', {
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as OutboxJob[];
    },
    async stillRelevant(outboxId) {
      const { data, error } = await api.rpc('outbox_still_relevant', { p_outbox_id: outboxId });
      if (error) throw new Error(error.message);
      return data === true;
    },
    async report(outboxId, result) {
      const { error } = await api.rpc('report_outbox_result', {
        p_outbox_id: outboxId,
        p_result: result,
      });
      if (error) throw new Error(error.message);
    },
    async whatsapp(outboxId) {
      const { data, error } = await api.rpc('get_whatsapp_send', { p_outbox_id: outboxId });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      return (row ?? null) as WhatsAppSend | null;
    },
    async reserve(outboxId) {
      const { data, error } = await api.rpc('reserve_send', { p_outbox_id: outboxId });
      if (error) throw new Error(error.message);
      return (data as { decision: string }).decision;
    },
    // A fresh registry per run: org secrets are read once per (org, channel) and gone with it.
    // LOCAL_PROVIDERS_ONLY defaults to true, so real providers need an explicit 'false'.
    // Org-owned providers are built by factories.ts. PROVIDER_API_BASE_<NAME> points one at a local
    // fake (deployment env only; org settings can't reach it).
    registry: () =>
      new DbChannelRegistry({
        async fetchConfig(orgId, kind) {
          const { data, error } = await api.rpc('get_channel_config', { p_org_id: orgId, p_channel: kind });
          if (error) throw new Error(error.message);
          const row = Array.isArray(data) ? data[0] : data;
          return row as ChannelConfig | null;
        },
        factories: providerFactories({
          functionsUrl,
          apiBase: Object.fromEntries(
            ['twilio', 'telnyx', 'vonage', 'plivo', 'postmark', 'resend', 'meta'].flatMap((name) => {
              const origin = Deno.env.get(`PROVIDER_API_BASE_${name.toUpperCase()}`);
              return origin ? [[name, origin]] : [];
            }),
          ),
        }),
        local: createRegistry(channels),
        localOnly: localProvidersOnly(Deno.env.get('LOCAL_PROVIDERS_ONLY')),
      }),
    secret: env('DISPATCH_SECRET'),
    // UNSUBSCRIBE_SECRET is shared with the unsubscribe function; PUBLIC_SITE_URL hosts /u, and
    // PUBLIC_FUNCTIONS_URL is the https gateway mail clients can reach (SUPABASE_URL is internal
    // locally, and secrets can't start with SUPABASE_). Hosted, SUPABASE_URL is already public.
    unsubscribe: Deno.env.get('UNSUBSCRIBE_SECRET') && Deno.env.get('PUBLIC_SITE_URL')
      ? {
        secret: env('UNSUBSCRIBE_SECRET'),
        page: new URL('/u', env('PUBLIC_SITE_URL')).toString(),
        endpoint: oneClickEndpoint(Deno.env.get('PUBLIC_FUNCTIONS_URL') ?? Deno.env.get('SUPABASE_URL')),
      }
      : undefined,
    appUrl: appOrigin(Deno.env.get('PUBLIC_URL')),
    log: observe.log,
    error: observe.error,
  })),
);

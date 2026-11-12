// N3 (#69): dispatch-notifications, the only sender of outbound messages (I-11). Kicked by pg_net
// after an enqueue and by pg_cron every 15 s. Each run claims due outbox rows with a lease, drops
// the ones a later state made pointless, renders and sends through the channel registry, and
// reports every outcome. Retries, backoff and dead-lettering are decided by
// api.report_outbox_result; consent and suppression by the channel (policy.ts), the send window by api.claim_outbox.
// Everything that touches Supabase is injected, so the tests run this with fakes.
//
// POST (Authorization: Bearer <DISPATCH_SECRET>). The gateway's JWT check is off for this function
// (config.toml), so this secret is the only gate; the vault secret dispatcher_key holds it.
//   200 { claimed, sent, failed, suppressed, gone }
//   401 { error: "unauthorized" }   anything but the secret, including the anon and service keys
//   405 { error: "method_not_allowed" }
import type { Database } from '@qm/db-types';
// Relative, not '@qm/domain': the e2e specs load this file in Node, which has no workspace link.
import { renderTemplate as render, templateParams } from '../../../packages/domain/src/templates.ts';

export { render };
import type {
  ChannelRegistry,
  NotificationTrigger,
  OutboundMessage,
  Recipient,
  SendResult,
} from '@qm/providers';
import { PRODUCT_NAME, SOURCE_CODE_URL } from '../../../packages/domain/src/source.ts';
import { renderEmail } from '../../../packages/providers/src/email/templates/layout.ts';
import { unsubscribeLink } from '../_shared/unsubscribe-token.ts';

export type OutboxJob = Database['api']['CompositeTypes']['outbox_job'];

/** The p_result of api.report_outbox_result. */
export interface OutboxReport {
  status: SendResult['status'];
  provider?: string;
  provider_message_id?: string;
  error_code?: string;
  retryable?: boolean;
  segments?: number;
  cost_micros?: number;
}

/** The row api.get_whatsapp_send returns. */
export interface WhatsAppSend {
  mode: 'session' | 'template' | null;
  wa_name: string | null;
  wa_language: string | null;
  window_open: boolean;
}

export interface DispatchDeps {
  /** api.claim_outbox */
  claim(limit: number, leaseSeconds: number): Promise<OutboxJob[]>;
  /** api.outbox_still_relevant */
  stillRelevant(outboxId: string): Promise<boolean>;
  /** api.report_outbox_result */
  report(outboxId: string, result: OutboxReport): Promise<void>;
  /**
   * api.reserve_send: the daily cap, country allowlist and budget check before a paid send.
   * Anything but `allowed` is a refusal code (a deployment can add its own, private.ext_send_refusal).
   */
  reserve(outboxId: string): Promise<string>;
  /**
   * api.get_whatsapp_send: how to send one whatsapp row (free text inside the window, else the
   * approved template). Without it WhatsApp messages carry no template, which Meta refuses
   * outside the 24 h window.
   */
  whatsapp?(outboxId: string): Promise<WhatsAppSend | null>;
  /**
   * A function returns a fresh registry per dispatch run, so per-org secrets live for one
   * invocation only (DbChannelRegistry caches for its own lifetime).
   */
  registry: ChannelRegistry | (() => ChannelRegistry);
  /** DISPATCH_SECRET; shorter than 32 characters means nobody may call. */
  secret: string;
  /** Receives ids, channels and outcomes only, never an address or message text. */
  log(line: string): void;
  /** A send that threw, worth an error report (`cause` stays out of it); defaults to `log`. */
  error?(line: string, cause: unknown): void;
  /**
   * Signed stop links for guest email: `page` is the /u confirm page (the {unsubscribe_url}
   * placeholder), `endpoint` the unsubscribe function (the List-Unsubscribe header, sent only
   * when there is one; see oneClickEndpoint). Without it, or with a secret under 32 characters,
   * mail goes out with no stop link.
   */
  unsubscribe?: { secret: string; page: string; endpoint?: string };
  /**
   * The web app's origin (PUBLIC_URL, no trailing slash) for the {app_url} placeholder in account
   * mail, so a message can link into the admin console. Unset, the optional `[... {app_url}...]`
   * sentence is dropped. It comes only from here, never from stored vars.
   */
  appUrl?: string;
}

/**
 * The List-Unsubscribe endpoint for a functions base URL, or undefined when the base isn't https:
 * RFC 8058 one-click needs https, and an internal gateway (http://kong:8000) is useless to a mail client.
 */
export function oneClickEndpoint(base: string | undefined): string | undefined {
  if (!base) return undefined;
  const url = new URL('/functions/v1/unsubscribe', base);
  return url.protocol === 'https:' ? url.toString() : undefined;
}

/** The https origin of PUBLIC_URL without a trailing slash, or undefined when it is unset or not https. */
export function appOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export const BATCH = { limit: 50, leaseSeconds: 60, maxBatches: 10 } as const;

function toReport(result: SendResult, provider?: string): OutboxReport {
  switch (result.status) {
    case 'sent':
      return {
        status: 'sent',
        provider,
        provider_message_id: result.providerMessageId,
        segments: result.segments,
        cost_micros: result.costMicros,
      };
    case 'failed':
      return { status: 'failed', provider, retryable: result.retryable, error_code: result.code };
    case 'gone':
      return { status: 'gone', provider, error_code: result.code };
    case 'suppressed':
      return { status: 'suppressed', provider, error_code: result.reason };
  }
}

/** Decides one job's outcome. Never throws for a send problem; only a broken RPC throws. */
async function outcome(
  deps: DispatchDeps,
  registry: ChannelRegistry,
  job: OutboxJob,
): Promise<OutboxReport> {
  const id = job.id!;
  if (!job.recipient) return { status: 'gone', error_code: 'recipient_deleted' };
  if (!(await deps.stillRelevant(id))) return { status: 'suppressed', error_code: 'not_relevant' };
  if (!job.body) return { status: 'failed', retryable: false, error_code: 'no_template' };
  const channel = await registry.get(job.org_id!, job.channel!);
  if (!channel) {
    const reason = registry.missingReason?.(job.org_id!, job.channel!);
    return reason
      ? { status: 'suppressed', error_code: reason }
      : { status: 'failed', retryable: false, error_code: 'no_channel' };
  }

  // WhatsApp: free text only inside the guest's window, otherwise the approved template with this
  // message's values as its positional parameters. No approved mapping -> dead, never free text.
  let whatsapp: OutboundMessage['whatsapp'];
  if (job.channel === 'whatsapp' && deps.whatsapp && channel.providerName !== 'console') {
    const send = await deps.whatsapp(id);
    if (!send?.mode) return { status: 'suppressed', error_code: 'not_relevant' };
    if (send.mode === 'session') whatsapp = { windowOpen: true };
    else if (!send.wa_name || !send.wa_language) {
      return { status: 'failed', retryable: false, error_code: 'no_approved_template' };
    } else {
      const { unsubscribe_url: _drop, ...values } = (job.vars ?? {}) as Record<string, unknown>;
      whatsapp = {
        windowOpen: false,
        template: {
          name: send.wa_name,
          language: send.wa_language,
          params: templateParams(job.body, values, job.locale ?? 'en'),
        },
      };
    }
  }

  // Paid channels (SMS, WhatsApp) must pass the org's limits first; a refusal never reaches the provider.
  // Rows that would be refused anyway (no consent, suppressed) are not counted. The console stand-in is free.
  if (
    (job.channel === 'sms' || job.channel === 'whatsapp') && channel.providerName !== 'console' &&
    job.has_consent === true && job.is_suppressed !== true
  ) {
    const decision = await deps.reserve(id);
    if (decision !== 'allowed') return { status: 'suppressed', error_code: decision };
  }

  // A stop link comes only from the signed link below, never from stored vars.
  const { unsubscribe_url: _stored, app_url: _app, manage_url: _m, cancel_url: _c, ...stored } = (job.vars ?? {}) as Record<string, unknown>;
  let vars: Record<string, unknown> = stored;
  let unsubscribeUrl: string | undefined;
  const stop = deps.unsubscribe;
  // Guest email only (a visit's or an appointment's): account mail is the member's own, and SMS
  // stops with a STOP reply.
  const guestMail = job.visit_id || job.template_key?.startsWith('appointment_') || job.template_key === 'guest_incident_notice';
  if (job.channel === 'email' && guestMail && stop && stop.secret.length >= 32) {
    vars = { ...vars, unsubscribe_url: await unsubscribeLink(stop.page, stop.secret, id) };
    if (stop.endpoint) unsubscribeUrl = await unsubscribeLink(stop.endpoint, stop.secret, id);
  }
  // An appointment email's one-off manage path (claim_outbox mints it) becomes the change and cancel
  // links; unset, their optional sentences drop out. It is never taken from stored vars.
  const managePath = job.status_url?.startsWith('/a/') ? job.status_url : undefined;
  if (job.channel === 'email' && managePath && deps.appUrl) {
    vars = { ...vars, manage_url: deps.appUrl + managePath, cancel_url: `${deps.appUrl}${managePath}?cancel=1` };
  }
  if (!job.visit_id && !job.template_key?.startsWith('appointment_') && deps.appUrl) {
    vars = { ...vars, app_url: deps.appUrl };
  }
  let text = render(job.body, vars);
  let html: string | undefined;
  if (job.channel === 'email') {
    const parts = renderEmail({
      text,
      url: managePath ? undefined : (job.status_url ?? undefined),
      // AGPL s13: the source link always; the product name unless the org hides it (claim_outbox sets the var).
      source: {
        sourceUrl: SOURCE_CODE_URL,
        productName: vars.org_hide_product_branding === true ? null : PRODUCT_NAME,
      },
      // CAN-SPAM: marketing mail names its sender and can be stopped, or it is not sent at all.
      footer:
        job.category === 'marketing'
          ? {
              legalName: vars.org_legal_name as string | null,
              postalAddress: vars.org_postal_address as string | null,
              unsubscribeUrl: vars.unsubscribe_url as string | undefined,
            }
          : undefined,
    });
    if (!parts.ok) return { status: 'failed', retryable: false, error_code: parts.code };
    ({ text, html } = parts);
  }
  const msg: OutboundMessage = {
    outboxId: id,
    orgId: job.org_id!,
    channel: job.channel!,
    category: job.category!,
    trigger: job.template_key as NotificationTrigger,
    to: job.recipient as unknown as Recipient,
    subject: job.subject ? render(job.subject, vars) : undefined,
    text,
    html,
    url: managePath ? undefined : (job.status_url ?? undefined),
    unsubscribeUrl,
    whatsapp,
    policy: {
      hasConsent: job.has_consent === true,
      isSuppressed: job.is_suppressed === true,
      locationTz: job.location_tz,
    },
  };
  return toReport(await channel.send(msg), channel.providerName);
}

export type DispatchSummary = Record<'claimed' | SendResult['status'], number>;

/** Claims and settles batches until the outbox has nothing due or maxBatches ran. */
export async function dispatch(deps: DispatchDeps): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: 0, sent: 0, failed: 0, suppressed: 0, gone: 0 };
  const registry = typeof deps.registry === 'function' ? deps.registry() : deps.registry;
  for (let batch = 0; batch < BATCH.maxBatches; batch++) {
    const jobs = await deps.claim(BATCH.limit, BATCH.leaseSeconds);
    summary.claimed += jobs.length;
    await Promise.all(
      jobs.map(async (job) => {
        try {
          const report = await outcome(deps, registry, job);
          await deps.report(job.id!, report);
          summary[report.status]++;
          deps.log(`outbox ${job.id} ${job.channel} ${report.status} ${report.error_code ?? ''}`);
        } catch (err) {
          // The lease runs out and the row is claimed again; nothing else to do here.
          const line = `outbox ${job.id} ${job.channel} error`;
          if (deps.error) deps.error(line, err);
          else deps.log(`${line} ${String(err)}`);
        }
      }),
    );
    if (jobs.length < BATCH.limit) break;
  }
  return summary;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Constant-time string comparison, so the key can't be guessed byte by byte. */
function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function createDispatchHandler(deps: DispatchDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const auth = req.headers.get('Authorization') ?? '';
    if (deps.secret.length < 32 || !sameKey(auth, `Bearer ${deps.secret}`)) {
      return json(401, { error: 'unauthorized' });
    }
    return json(200, await dispatch(deps));
  };
}

// 2B-I7 (#312): deliver-webhooks, the only sender of outgoing webhooks. Kicked by pg_net after an
// enqueue and by pg_cron every minute. Each run claims due deliveries with a lease, signs and POSTs
// them, and reports every outcome; the database keeps the attempt count and the endpoint's health.
// Outbound requests are an SSRF risk, so every URL is resolved first and refused when it points at a
// loopback, private, link-local or metadata address (unless WEBHOOK_ALLOW_PRIVATE is set for a LAN
// self-host). Everything that touches the network or Supabase is injected, so the tests use fakes.
//
// POST (Authorization: Bearer <DISPATCH_SECRET>), same secret and gate as dispatch-notifications.
//   200 { claimed, delivered, failed, dead }   401 unauthorized   405 method_not_allowed
import { signWebhook } from '../../../packages/domain/src/webhook-signature.ts';
import { type AlertEvent, type ChatKind, formatChatAlert } from '../../../packages/domain/src/chat-alert-format.ts';

/** The job shape of api.claim_webhook_deliveries. */
export interface WebhookJob {
  delivery_id: string;
  url: string;
  kind: string;
  event_type: string;
  payload: Record<string, unknown>;
  /** One signing secret, or two comma separated while a rotated secret is still valid. */
  secret: string;
  /** Attempts already made. */
  attempt: number;
}

/** The p_result of api.report_webhook_result. */
export interface WebhookReport {
  status: 'delivered' | 'failed';
  response_status?: number;
  response_ms?: number;
  error?: string;
  /** false stops retrying at once (the delivery goes dead). */
  retryable?: boolean;
  retry_in_seconds?: number;
  /** The attempt count the delivery was claimed with; a report for another claim is ignored. */
  attempt?: number;
}

export interface DeliverDeps {
  claim(limit: number, leaseSeconds: number): Promise<WebhookJob[]>;
  report(deliveryId: string, result: WebhookReport): Promise<void>;
  /** A and AAAA records of a host (an IP literal resolves to itself). */
  resolve(host: string): Promise<string[]>;
  /** POSTs once without following redirects; throws on timeout. The body read is capped by the caller. */
  post(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number }>;
  secret: string;
  allowPrivate: boolean;
  /** Unix seconds. */
  now(): number;
  /** Receives endpoint host, status and ids only, never a payload, URL path or secret. */
  log(line: string): void;
}

/** Seconds to wait after the nth failed attempt (0-based): 1m, 5m, 30m, 2h, 6h, 12h, 24h. */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600, 43200, 86400];
export const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 10_000;

/** True for loopback, private, link-local, unique-local, multicast, reserved and metadata addresses. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && Number(v4[3]) === 100) || (a === 203 && b === 0 && Number(v4[3]) === 113);
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedAddress(mapped[1]!);
  const hexMapped = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // 6to4 (2002:AABB:CCDD::) and IPv4-compatible (::AABB:CCDD) carry an IPv4 address: test it.
  const sixToFour = v6.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(:|$)/);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1]!, 16);
    const lo = parseInt(sixToFour[2]!, 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const compat = v6.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (compat) return true;
  if (!v6.includes(':')) return true; // not an address we understand
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89abcdef]/.test(v6) || /^ff/.test(v6) ||
    v6.startsWith('2001:db8') || v6.startsWith('64:ff9b') || v6.startsWith('::ffff:0:');
}

const CHAT_HOSTS: Record<string, RegExp> = {
  slack: /^hooks\.slack\.com$/,
  discord: /^(discord|discordapp)\.com$/,
  teams: /(^|\.)(webhook\.office\.com|logic\.azure\.com|powerplatform\.com)$/,
};

/** Why a URL may not be called, or null. Resolves the host, so call it for every attempt. */
async function refusal(job: WebhookJob, deps: DeliverDeps): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(job.url);
  } catch {
    return 'blocked_url';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'blocked_url';
  if (url.username || url.password) return 'blocked_url';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const vendor = CHAT_HOSTS[job.kind];
  if (vendor && (!vendor.test(host) || url.protocol !== 'https:' || url.port)) return 'blocked_host';
  if (deps.allowPrivate) return null;
  // The resolver does not read /etc/hosts, so names fetch resolves locally would pass unseen.
  if (!host.includes('.') && !host.includes(':')) return 'blocked_host';
  if (/\.(local|localhost|internal|lan|home\.arpa)$/i.test(host)) return 'blocked_host';
  let addresses: string[];
  try {
    addresses = await Promise.race([
      deps.resolve(host),
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('dns_timeout')), 3000)),
    ]);
  } catch {
    return 'dns_failed';
  }
  if (addresses.length === 0) return 'dns_failed';
  return addresses.some(isBlockedAddress) ? 'blocked_address' : null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function deliverOne(job: WebhookJob, deps: DeliverDeps): Promise<'delivered' | 'failed' | 'dead'> {
  const dead = job.attempt + 1 >= MAX_ATTEMPTS;
  const fail = async (error: string, status?: number, ms?: number, retryable = true) => {
    await deps.report(job.delivery_id, {
      status: 'failed', attempt: job.attempt, error, response_status: status, response_ms: ms, retryable,
      retry_in_seconds: BACKOFF_SECONDS[Math.min(job.attempt, BACKOFF_SECONDS.length - 1)],
    });
    return !retryable || dead ? 'dead' as const : 'failed' as const;
  };
  const host = (() => { try { return new URL(job.url).host; } catch { return 'invalid'; } })();
  const blocked = await refusal(job, deps);
  if (blocked) {
    deps.log(`webhook ${job.delivery_id} host=${host} ${blocked}`);
    return fail(blocked, undefined, undefined, blocked === 'dns_failed');
  }
  // Chat kinds (slack, discord, teams) get the vendor's own message format and no HMAC headers:
  // the secret webhook URL is their credential.
  const chat = job.kind === 'slack' || job.kind === 'discord' || job.kind === 'teams';
  const body = JSON.stringify(chat ? formatChatAlert(job.kind as ChatKind, job.payload as unknown as AlertEvent) : job.payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'QueueThat-Webhooks/1' };
  if (!chat) {
    const secrets = job.secret.split(',').filter(Boolean);
    headers['X-QM-Signature'] = await signWebhook(secrets, body, deps.now());
    headers['X-QM-Event-Id'] = String(job.payload.id ?? '');
    headers['X-QM-Event-Type'] = job.event_type;
  }
  const started = Date.now();
  try {
    const res = await deps.post(job.url, headers, body, TIMEOUT_MS);
    const ms = Date.now() - started;
    deps.log(`webhook ${job.delivery_id} host=${host} status=${res.status}`);
    if (res.status >= 200 && res.status < 300) {
      await deps.report(job.delivery_id, { status: 'delivered', attempt: job.attempt, response_status: res.status, response_ms: ms });
      return 'delivered';
    }
    return fail(`http_${res.status}`, res.status, ms, res.status !== 410);
  } catch {
    deps.log(`webhook ${job.delivery_id} host=${host} network_error`);
    return fail('network_error', undefined, Date.now() - started);
  }
}

export function createDeliverHandler(deps: DeliverDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const auth = req.headers.get('Authorization') ?? '';
    if (deps.secret.length < 32 || !sameKey(auth, `Bearer ${deps.secret}`)) {
      return json(401, { error: 'unauthorized' });
    }
    const jobs = await deps.claim(50, 60);
    const tally = { claimed: jobs.length, delivered: 0, failed: 0, dead: 0 };
    // A bounded number at a time, so one slow receiver cannot eat the 60 s lease of the rest.
    // Stop starting batches well inside the lease; what is left is claimed again after it expires.
    const stopAt = Date.now() + 35_000;
    for (let i = 0; i < jobs.length && Date.now() < stopAt; i += 10) {
      const results = await Promise.allSettled(jobs.slice(i, i + 10).map((j) => deliverOne(j, deps)));
      for (const r of results) if (r.status === 'fulfilled') tally[r.value]++;
    }
    return json(200, tally);
  };
}

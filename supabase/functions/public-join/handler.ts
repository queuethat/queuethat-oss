// public-join (2A-JN2, #112): the one anonymous path to create a visit once 2A-JN4 revokes anon's
// EXECUTE on api.join_queue. It adds what the database cannot: a CAPTCHA check with the configured
// provider and per-IP limits that survive a rolled-back join. The join itself is api.join_queue
// with the service role, so every database rule (accepting predicate, capacity, caps, on-site
// code) still applies and its error codes come back 1:1.
//
// GET  /challenge   proof-of-work providers only: { challenge, difficulty, expiresAt }
// POST /phone-code { token, captcha }   sends the guest a verification code (#986): a CAPTCHA and the per-IP
//                     limit in front of api.guest_request_phone_code, whose anon EXECUTE is revoked.
//   200 { state, resend_after }  400 invalid_input | captcha_failed  404 not_found  429 rate_limited
//   and the database's consent_required | sms_unavailable (409)
// POST /            { queueId | locationId, serviceId?, name, phone?, email?, partySize?, locale?,
//                     idempotencyKey, deviceKey?, answers?, groupKey?, onsiteCode?, captcha }
//   200 { token, display_ticket, status }
//   400 invalid_input | captcha_failed        403 onsite_code_*, org_suspended, forbidden
//   404 not_found                              409 queue_not_accepting, capacity_reached, ...
//   429 rate_limited (+ Retry-After)           500 unknown
// Raw IP addresses are only hashed (sha256 of ip + a daily salt) and never stored or logged.

import type { CaptchaVerifier } from '../../../packages/providers/src/captcha/verifier.ts';

/** A database error as PostgREST reports it: message is the code, details is the DETAIL. */
export class JoinError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

/** Where a join came from; the only `src` values the database keeps (visits.attribution, 2B-J8). */
export const ATTRIBUTIONS = ['gbp', 'widget', 'poster'] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

/** The allowlisted attribution for a client's `src`, else null: unknown text is dropped, never stored. */
export function attributionFor(src: unknown): Attribution | null {
  return ATTRIBUTIONS.find((a) => a === src) ?? null;
}

/** The guest's position as the browser reported it; the database decides what it is worth. */
export interface Geo {
  lat: number;
  lng: number;
  accuracyM: number;
}

export interface JoinArgs {
  /** Null for a location-level join, which the database routes (Q-11). */
  p_queue_id: string | null;
  p_location_id?: string;
  p_service_id: string | null;
  p_name: string;
  p_phone_e164: string | null;
  p_email: string | null;
  p_party_size: number;
  p_locale: string | null;
  p_idempotency_key: string;
  p_device_key: string | null;
  p_answers: Record<string, unknown>;
  p_group_key: string | null;
  p_onsite_code: string | null;
  /** Join for later (2B-J4): when the guest enters the line, validated by the database. */
  p_arrive_after?: string;
}

export interface PublicJoinDeps {
  captcha: CaptchaVerifier;
  /** ops.hit_rate_limit: true while within the limit; count=false only looks. */
  hit(key: string, limit: number, windowSeconds: number, count?: boolean): Promise<boolean>;
  /**
   * api.join_queue with the service role; throws JoinError. `ip` is forwarded as x-qm-client-ip
   * and `geo` as x-qm-geo, which the database reads for geofenced queues (2B-Q10).
   */
  join(args: JoinArgs, ip: string | null, geo?: Geo | null, src?: Attribution | null): Promise<{ token: string | null; display_ticket: string; status: string }>;
  /**
   * api.guest_request_phone_code with the service role (anon cannot call it, so this check cannot be
   * skipped); throws JoinError. `ip` is forwarded as x-qm-client-ip like a join's.
   */
  requestPhoneCode(token: string, ip: string | null): Promise<{ state: string; resend_after: string | null }>;
  /** sha256(ip + daily salt), hex. */
  hashIp(ip: string): Promise<string>;
  /** PUBLIC_URL: the only origin allowed to call. */
  publicUrl: string;
  /** The header the deployment's proxy sets with the real client address. Default x-real-ip. */
  clientIpHeader?: 'x-real-ip' | 'cf-connecting-ip';
  ipLimit?: number;
  ipWindowSeconds?: number;
  codeLimit?: number;
  codeWindowSeconds?: number;
  now?: () => number;
  error?(line: string, cause: unknown): void;
}

const MAX_BODY = 4096;

/** A plausible IPv4 or IPv6 literal. Not a parser: it keeps junk out of hashes and keys. */
export function isAddress(text: string): boolean {
  if (text.length < 2 || text.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text.split('.').every((n) => Number(n) <= 255);
  return text.includes(':') && /^[0-9a-fA-F:.]+$/.test(text) && !/:::/.test(text);
}

/** Reads at most MAX_BODY bytes; null when the body is larger. */
async function readCapped(req: Request): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}
/**
 * The address a limit is keyed on: an IPv6 client is its /64 (one household or one subscriber gets a
 * whole /64, so per-address keys would be unlimited), matching private.client_ip's database limits.
 * IPv4 and IPv4-mapped addresses are kept as they are.
 */
export function networkOf(ip: string): string {
  if (!ip.includes(':')) return ip;
  if (/^::ffff:/i.test(ip) && ip.includes('.')) return ip.toLowerCase();
  if (ip.includes('.')) ip = ip.replace(/[0-9.]+$/, '0:0'); // embedded IPv4 sits in the host half
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<string, number> = {
  invalid_input: 400,
  captcha_failed: 400,
  captcha_required: 400,
  onsite_code_required: 403,
  onsite_code_invalid: 403,
  onsite_required: 403,
  org_suspended: 403,
  forbidden: 403,
  not_found: 404,
  queue_not_accepting: 409,
  capacity_reached: 409,
  too_many_active_visits: 409,
  no_route: 409,
  already_in_queue: 409,
  invalid_arrive_after: 400,
  rate_limited: 429,
};

export function createPublicJoinHandler(deps: PublicJoinDeps): (req: Request) => Promise<Response> {
  const ipLimit = deps.ipLimit ?? 10;
  const ipWindow = deps.ipWindowSeconds ?? 600;
  const codeLimit = deps.codeLimit ?? 5;
  const codeWindow = deps.codeWindowSeconds ?? 600;
  const now = deps.now ?? Date.now;
  const allowedOrigin = new URL(deps.publicUrl).origin;
  const error = deps.error ?? (() => {});

  const baseHeaders = (origin: string | null): Record<string, string> => ({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    ...(origin === allowedOrigin
      ? {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Expose-Headers': 'Retry-After',
        }
      : {}),
  });

  function retryAfter(windowSeconds: number): number {
    return windowSeconds - (Math.floor(now() / 1000) % windowSeconds);
  }

  return async (req) => {
    const origin = req.headers.get('origin');
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { ...baseHeaders(origin), ...extra } });
    const tooMany = (windowSeconds: number) =>
      json(429, { error: 'rate_limited' }, { 'Retry-After': String(retryAfter(windowSeconds)) });

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: baseHeaders(origin) });
    }
    if (origin !== null && origin !== allowedOrigin) return json(403, { error: 'forbidden' });

    const url = new URL(req.url);
    // Only the header our own proxy sets is believed (as deployment_settings.client_ip_header);
    // the others are the client's to write. Anything that is not an address counts as unknown.
    const raw = req.headers.get(deps.clientIpHeader ?? 'x-real-ip')?.trim() ?? '';
    const ip = isAddress(raw) ? raw : null;
    const ipHash = await deps.hashIp(ip ?? 'unknown');

    if (req.method === 'GET' && url.pathname.endsWith('/challenge')) {
      if (!deps.captcha.issueChallenge) return json(404, { error: 'not_found' });
      if (!(await deps.hit(`challenge:${ipHash}`, ipLimit * 6, ipWindow))) return tooMany(ipWindow);
      return json(200, await deps.captcha.issueChallenge());
    }
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });

    if (url.pathname.endsWith('/phone-code')) {
      const body = await readCapped(req);
      let parsed: unknown;
      try {
        parsed = body === null ? null : JSON.parse(body);
      } catch {
        parsed = null;
      }
      const b = parsed as Record<string, unknown> | null;
      if (
        !b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'token' && k !== 'captcha') ||
        typeof b.token !== 'string' || b.token.length < 8 || b.token.length > 200 ||
        (b.captcha !== undefined && (typeof b.captcha !== 'string' || b.captcha.length > 4000))
      ) {
        return json(400, { error: 'invalid_input' });
      }
      // A code costs real money, so there is no shared "unknown" bucket here: without the proxy's
      // client address the request is refused, loudly, rather than limited together with everyone.
      if (ip === null) {
        error('public phone code refused: no client address (check CLIENT_IP_HEADER and the proxy)', null);
        return json(403, { error: 'forbidden' });
      }
      // Its own allowance, per network (an IPv6 client is its /64).
      const networkHash = await deps.hashIp(networkOf(ip));
      if (!(await deps.hit(`phone-code:${networkHash}`, 10, 3600))) return tooMany(3600);
      const checked = await deps.captcha.verify((b.captcha as string | undefined) ?? '', { ipHash: networkHash });
      if (!checked.ok) return json(400, { error: 'captcha_failed' });
      try {
        return json(200, await deps.requestPhoneCode(b.token, ip));
      } catch (failure) {
        if (failure instanceof JoinError) {
          const status = failure.code === 'consent_required' || failure.code === 'sms_unavailable' ? 409 : STATUS[failure.code] ?? 400;
          return json(status, { error: failure.code }, failure.code === 'rate_limited' ? { 'Retry-After': '300' } : {});
        }
        error('public phone code failed', failure);
        return json(500, { error: 'unknown' });
      }
    }

    // Body: size first, then strict shape.
    const text = await readCapped(req);
    if (text === null) return json(400, { error: 'invalid_input' });
    const args = parseBody(text);
    if (!args) return json(400, { error: 'invalid_input' });

    // Per-IP limit first, so failed CAPTCHAs and bad codes cost the caller their allowance too.
    if (!(await deps.hit(`join:${ipHash}`, ipLimit, ipWindow))) return tooMany(ipWindow);
    // A wrong on-site code is rolled back with the join, so the database cannot count it: look at
    // our own counter before spending the join.
    if ((args.join.p_onsite_code !== null || args.geo !== null) && !(await deps.hit(`code:${ipHash}`, codeLimit, codeWindow, false))) {
      return tooMany(codeWindow);
    }

    const verdict = await deps.captcha.verify(args.captcha, { ipHash });
    if (!verdict.ok) return json(400, { error: 'captcha_failed' });

    try {
      const joined = await deps.join(args.join, ip, args.geo, args.src);
      return json(200, joined);
    } catch (failure) {
      if (failure instanceof JoinError) {
        if (failure.code === 'onsite_code_invalid' || failure.code === 'onsite_required') {
          await deps.hit(`code:${ipHash}`, codeLimit, codeWindow);
        }
        const retry: Record<string, string> = failure.code === 'rate_limited' ? { 'Retry-After': '60' } : {};
        return json(STATUS[failure.code] ?? 400, {
          error: failure.code,
          ...(failure.detail ? { detail: failure.detail } : {}),
        }, retry);
      }
      error('public join failed', failure);
      return json(500, { error: 'unknown' });
    }
  };
}

const KEYS = new Set([
  'queueId', 'locationId', 'serviceId', 'name', 'phone', 'email', 'partySize', 'locale', 'idempotencyKey',
  'deviceKey', 'answers', 'groupKey', 'onsiteCode', 'geo', 'src', 'captcha', 'arriveAfter',
]);

function parseGeo(v: unknown): Geo | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const g = v as Record<string, unknown>;
  if (Object.keys(g).some((k) => k !== 'lat' && k !== 'lng' && k !== 'accuracyM')) return undefined;
  const { lat, lng, accuracyM } = g;
  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof accuracyM !== 'number') return undefined;
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && accuracyM >= 0 && accuracyM <= 100000)) return undefined;
  return { lat, lng, accuracyM };
}

/** Strict shape check; returns null on anything unexpected. */
export function parseBody(text: string): { join: JoinArgs; captcha: string; geo: Geo | null; src: Attribution | null } | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !KEYS.has(k))) return null;

  const str = (v: unknown, max: number): string | null | undefined =>
    v === undefined || v === null ? null : typeof v === 'string' && v.length <= max ? v : undefined;
  const uuid = (v: unknown): string | null | undefined =>
    v === undefined || v === null ? null : typeof v === 'string' && UUID.test(v) ? v : undefined;

  const queueId = uuid(b.queueId);
  const locationId = uuid(b.locationId);
  const serviceId = uuid(b.serviceId);
  const groupKey = uuid(b.groupKey);
  const key = uuid(b.idempotencyKey);
  const name = str(b.name, 200);
  const phone = str(b.phone, 32);
  const email = str(b.email, 254);
  const locale = str(b.locale, 35);
  const deviceKey = str(b.deviceKey, 128);
  const onsite = str(b.onsiteCode, 16);
  const captcha = str(b.captcha, 4000);
  const geo = parseGeo(b.geo);
  const arriveAfter = str(b.arriveAfter, 40);
  const party = b.partySize === undefined || b.partySize === null ? 1 : b.partySize;
  const answers = b.answers === undefined || b.answers === null ? {} : b.answers;
  if (
    // Exactly one target: a queue, or a location whose routing rules choose the queue.
    queueId === undefined || locationId === undefined || (queueId === null) === (locationId === null) ||
    !key || name === undefined || phone === undefined || email === undefined ||
    locale === undefined || deviceKey === undefined || onsite === undefined || captcha === undefined ||
    serviceId === undefined || groupKey === undefined || geo === undefined || arriveAfter === undefined ||
    (arriveAfter !== null && Number.isNaN(Date.parse(arriveAfter))) || !Number.isInteger(party) ||
    typeof answers !== 'object' || Array.isArray(answers)
  ) {
    return null;
  }
  return {
    captcha: captcha ?? '',
    geo,
    src: attributionFor(b.src),
    join: {
      p_queue_id: queueId,
      ...(locationId ? { p_location_id: locationId } : {}),
      p_service_id: serviceId,
      p_name: name ?? '',
      p_phone_e164: phone,
      p_email: email,
      p_party_size: party as number,
      p_locale: locale,
      p_idempotency_key: key,
      p_device_key: deviceKey,
      p_answers: answers as Record<string, unknown>,
      p_group_key: groupKey,
      p_onsite_code: onsite,
      ...(arriveAfter ? { p_arrive_after: arriveAfter } : {}),
    },
  };
}

import { appConfig } from '../../../lib/config.ts';
import { RpcError } from '../rpcError.ts';
import type { Answers } from '../api.ts';

// The guest side of the public-join Edge Function (2A-JN3, #113): which CAPTCHA the deployment
// uses, the proof-of-work challenge, and the join call itself. Plain fetch, like client.ts, so the
// guest bundle stays small.

export type JoinProvider = 'turnstile' | 'pow' | 'dev';

const PROVIDERS: readonly string[] = ['turnstile', 'pow', 'dev'];

/**
 * The CAPTCHA provider this build joins through, from VITE_PUBLIC_JOIN. Unset: the page calls
 * api.join_queue directly (and join-pass handles Turnstile), as before 2A-JN4 revokes that path.
 * The dev server also honours localStorage `qm:dev:public-join`, so e2e can pick one per test.
 */
export function joinProvider(): JoinProvider | null {
  let value: string | null | undefined = appConfig().publicJoin;
  if (import.meta.env.DEV) {
    try {
      value = localStorage.getItem('qm:dev:public-join') ?? value;
    } catch {
      // storage unavailable: use the build setting
    }
  }
  return value && PROVIDERS.includes(value) ? (value as JoinProvider) : null;
}

export interface Challenge {
  challenge: string;
  difficulty: number;
  expiresAt: string;
}

/** A refused public join. `retryAfter` is the seconds the server asked the caller to wait (429). */
export class PublicJoinError extends RpcError {
  constructor(
    code: string,
    detail: string | null,
    status: number,
    readonly retryAfter: number | null,
  ) {
    super(code, code, detail, status);
  }
}

function endpoint(path = ''): string {
  const { supabaseUrl: url } = appConfig();
  if (!url) throw new Error('VITE_SUPABASE_URL must be set.');
  return `${url}/functions/v1/public-join${path}`;
}

async function answer<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    (T & { error?: string; detail?: string }) | null;
  if (response.ok) return body as T;
  const retry = Number(response.headers.get('Retry-After'));
  // A 429 without our body is the gateway's own rule.
  const code = body?.error ?? (response.status === 429 ? 'rate_limited' : 'unknown');
  throw new PublicJoinError(
    code,
    body?.detail ?? (code === 'rate_limited' ? 'network' : null),
    response.status,
    Number.isFinite(retry) && retry > 0 ? retry : null,
  );
}

export async function fetchChallenge(): Promise<Challenge> {
  return answer<Challenge>(await fetch(endpoint('/challenge')));
}

/** A position as the browser's Geolocation API reports it. */
export interface Geo {
  lat: number;
  lng: number;
  accuracyM: number;
}

export interface PublicJoinBody {
  /** Null with `locationId`: the database routes the guest to a queue. */
  queueId: string | null;
  locationId?: string;
  serviceId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  partySize: number;
  locale: string;
  idempotencyKey: string;
  deviceKey: string | null;
  groupKey?: string | null;
  onsiteCode?: string | null;
  /** Where the browser says the guest is, for a queue that asks to be on site (2B-Q10). */
  geo?: Geo | null;
  /** The link's `?src=` hint; the function maps it to an allowlist (2B-J8). */
  src?: string | null;
  answers?: Answers;
  captcha: string;
  /** Join for later: when the guest enters the line (ISO). */
  arriveAfter?: string;
}

export interface PublicJoinResult {
  token: string | null;
  display_ticket: string;
  status: string;
}

/** POSTs a join. Rejects with PublicJoinError carrying the database's error code. */
export async function publicJoin(body: PublicJoinBody): Promise<PublicJoinResult> {
  return answer<PublicJoinResult>(
    await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export interface PhoneCodeResult {
  state: 'sent' | 'verified';
  resend_after: string | null;
}

/**
 * Asks public-join to text the guest a verification code (#986). `captcha` is a solved proof-of-work
 * token or the Turnstile token; the database call behind it is closed to anon.
 */
export async function requestPhoneCode(token: string, captcha: string): Promise<PhoneCodeResult> {
  return answer<PhoneCodeResult>(
    await fetch(endpoint('/phone-code'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, captcha }),
    }),
  );
}

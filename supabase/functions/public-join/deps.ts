// The Supabase and provider wiring of public-join, built from whichever supabase-js the runtime
// has: index.ts passes Deno's npm import, the e2e suite passes Node's (CI runs Supabase without
// the edge runtime).
import { devAlwaysPassVerifier } from '../../../packages/providers/src/captcha/dev.ts';
import { powVerifier, type SpentStore } from '../../../packages/providers/src/captcha/pow.ts';
import { turnstileVerifier } from '../../../packages/providers/src/captcha/turnstile.ts';
import type { CaptchaVerifier } from '../../../packages/providers/src/captcha/verifier.ts';
import { JoinError, type PublicJoinDeps } from './handler.ts';

// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export interface PublicJoinEnv {
  url: string;
  serviceRoleKey: string;
  publicUrl: string;
  captchaProvider: string;
  turnstileSecret?: string;
  powSecret?: string;
  powDifficulty?: number;
  environment?: string;
  /** Extra salt for IP hashes; defaults to the service role key (secret, never logged). */
  ipSalt?: string;
  ipLimit?: number;
  ipWindowSeconds?: number;
  clientIpHeader?: 'x-real-ip' | 'cf-connecting-ip';
}

type Hit = PublicJoinDeps['hit'];

/** Picks the CaptchaVerifier named by CAPTCHA_PROVIDER. Throws on a missing secret. */
export function buildVerifier(env: PublicJoinEnv, hit: Hit): CaptchaVerifier {
  switch (env.captchaProvider) {
    case 'turnstile':
      if (!env.turnstileSecret) throw new Error('TURNSTILE_SECRET_KEY is not set');
      return turnstileVerifier({ secret: env.turnstileSecret });
    case 'pow': {
      if (!env.powSecret) throw new Error('POW_SECRET is not set');
      // A solved challenge is spent once, across instances, in the same table as the IP buckets
      // (one-day window: a challenge lives two minutes).
      const spent: SpentStore = { markSpent: (key) => hit(`pow:${key}`, 1, 86400) };
      return powVerifier({ secret: env.powSecret, difficulty: env.powDifficulty, spent });
    }
    case 'dev':
      return devAlwaysPassVerifier({ ENVIRONMENT: env.environment });
    default:
      throw new Error('CAPTCHA_PROVIDER must be turnstile, pow or dev');
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function supabaseDeps(createClient: CreateClient, env: PublicJoinEnv): PublicJoinDeps {
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(env.url, env.serviceRoleKey, opts);
  const hit: Hit = async (key, limit, windowSeconds, count = true) => {
    const { data, error } = await admin.schema('api').rpc('hit_rate_limit', {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
      p_count: count,
    });
    // Fail closed: if the limiter is down we cannot tell a flood from a guest.
    if (error || typeof data !== 'boolean') throw new Error(error?.message ?? 'no rate limit answer');
    return data;
  };
  return {
    captcha: buildVerifier(env, hit),
    hit,
    publicUrl: env.publicUrl,
    clientIpHeader: env.clientIpHeader,
    ipLimit: env.ipLimit,
    ipWindowSeconds: env.ipWindowSeconds,
    hashIp: (ip) =>
      sha256Hex(`${ip}|${new Date().toISOString().slice(0, 10)}|${env.ipSalt ?? env.serviceRoleKey}`),
    async requestPhoneCode(token, ip) {
      const client = createClient(env.url, env.serviceRoleKey, {
        ...opts,
        global: { headers: ip ? { 'x-qm-client-ip': ip } : {} },
      });
      const { data, error } = await client.schema('api').rpc('guest_request_phone_code', { p_token: token });
      if (error) {
        const code = typeof error.message === 'string' && /^[a-z_]+$/.test(error.message) ? error.message : null;
        if (code) throw new JoinError(code, error.details ?? undefined);
        throw new Error(error.message ?? 'phone code failed');
      }
      return data;
    },
    async join(args, ip, geo, src) {
      // Per call: the guest's address rides along as x-qm-client-ip (Kong overwrites x-real-ip).
      const client = createClient(env.url, env.serviceRoleKey, {
        ...opts,
        global: {
          headers: {
            ...(ip ? { 'x-qm-client-ip': ip } : {}),
            ...(src ? { 'x-qm-src': src } : {}),
            ...(geo ? { 'x-qm-geo': `${geo.lat},${geo.lng},${geo.accuracyM}` } : {}),
          },
        },
      });
      const { data, error } = await client.schema('api').rpc('join_queue', args);
      if (error) {
        const code = typeof error.message === 'string' && /^[a-z_]+$/.test(error.message) ? error.message : null;
        if (code) throw new JoinError(code, error.details ?? undefined);
        throw new Error(error.message ?? 'join failed');
      }
      return data;
    },
  };
}

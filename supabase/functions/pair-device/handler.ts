// D1 (#48): pair-device. Turns a 6-digit pairing code from admin into a normal, refreshable
// Supabase session for a new auth user that is the display or kiosk (technical-design.md 5).
// Everything that touches Supabase is injected, so this file is plain web-platform TypeScript and
// the tests run it with fakes. index.ts wires the real clients.
//
// POST { "code": "123456" }
//   200 { session, device }        session is what supabase.auth.setSession() takes
//   400 { error: "invalid_input" } the body is not a 6-digit code
//   404 { error: "not_found" }     unknown, expired or used code, never saying which
//   429 { error: "rate_limited" }  too many failed codes from this client or from everyone
//   500 { error: "unknown" }

export type DeviceKind = 'display' | 'kiosk';

/** What api.redeem_pairing_code returns for a valid code. */
export interface DeviceClaim {
  device_id: string;
  org_id: string;
  location_id: string;
  kind: DeviceKind;
  name: string;
  scopes: string[];
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
}

export interface PairDeviceDeps {
  /** api.redeem_pairing_code: null for an invalid code; throws RateLimitedError. */
  redeem(code: string, clientKey: string): Promise<DeviceClaim | null>;
  /** Auth admin createUser with these app_metadata claims; returns the user id. */
  createUser(email: string, password: string, appMetadata: Record<string, unknown>): Promise<string>;
  deleteUser(userId: string): Promise<void>;
  /** Password grant for the user just created. */
  signIn(email: string, password: string): Promise<Session>;
  /** api.register_device: from here on the user passes private.is_device. */
  registerDevice(deviceId: string, userId: string): Promise<void>;
  /** A failure. `line` holds only fixed words and ids; the thrown value goes in `cause`. */
  log?(line: string, cause: unknown): void;
}

export class RateLimitedError extends Error {
  constructor() {
    super('rate_limited');
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** The caller's IP as the edge gateway reports it. Only its hash is stored, for rate limiting. */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return req.headers.get('cf-connecting-ip') ?? (forwarded || 'unknown');
}

/** 32 random bytes, base64url. The device never sees it; it only lives for the password grant. */
function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function createPairDeviceHandler(deps: PairDeviceDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});

  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });

    const body = await req.json().catch(() => null);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^[0-9]{6}$/.test(code)) return json(400, { error: 'invalid_input' });

    let claim: DeviceClaim | null;
    try {
      claim = await deps.redeem(code, clientKey(req));
    } catch (error) {
      if (error instanceof RateLimitedError) return json(429, { error: 'rate_limited' });
      log('redeem failed', error);
      return json(500, { error: 'unknown' });
    }
    if (!claim) return json(404, { error: 'not_found' });

    // The code is spent from here on. If anything below fails, admin creates a new one.
    const email = `device-${claim.device_id}@devices.invalid`;
    const password = randomPassword();
    let userId: string;
    try {
      userId = await deps.createUser(email, password, {
        kind: claim.kind,
        org_id: claim.org_id,
        location_id: claim.location_id,
        scopes: claim.scopes,
        device_id: claim.device_id,
      });
    } catch (error) {
      log(`createUser failed for device ${claim.device_id}`, error);
      return json(500, { error: 'unknown' });
    }

    try {
      const session = await deps.signIn(email, password);
      await deps.registerDevice(claim.device_id, userId);
      return json(200, {
        session,
        device: {
          id: claim.device_id,
          kind: claim.kind,
          org_id: claim.org_id,
          location_id: claim.location_id,
          name: claim.name,
        },
      });
    } catch (error) {
      log(`pairing failed for device ${claim.device_id}`, error);
      // Deleting the user also ends the session we may have just created.
      await deps.deleteUser(userId).catch((e) => log('deleteUser failed', e));
      return json(500, { error: 'unknown' });
    }
  };
}

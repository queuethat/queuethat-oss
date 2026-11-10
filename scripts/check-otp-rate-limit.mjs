// Pre-launch check that Supabase Auth rate-limits wrong sign-in codes (#509 security review).
// GoTrue keeps accepting guesses against a code, so the per-IP limit on POST /verify is what
// stops brute force. GoTrue applies that limit only when GOTRUE_RATE_LIMIT_HEADER names a
// header carrying the client IP; the Supabase CLI never sets it, so the local stack can't pass.
//
//   AUTH_URL=https://<ref>.supabase.co/auth/v1 APIKEY=<publishable key> node scripts/check-otp-rate-limit.mjs
//
// Round 1 sends wrong codes for an address with no account until it gets HTTP 429. Round 2
// repeats from the same machine with a different made-up X-Forwarded-For and X-Real-IP on every
// request; it must be limited too, or anyone can bypass the limit by spoofing those headers.
// Round 1 has already spent this IP's limit, so a correct setup answers round 2 with 429 at once
// ("after 1"), while a setup keyed on a spoofed header starts a fresh bucket per request and never
// does. The run spends this IP's limit for a few minutes (30 per 5 min by default), so don't run
// it from the shop's network.
//
//   MFA_EMAIL=<test account> MFA_PASSWORD=... AUTH_URL=... APIKEY=... node scripts/check-otp-rate-limit.mjs
//
// With MFA_EMAIL set it checks wrong authenticator-app codes instead (#417 security review): it
// signs in as that account (one without an authenticator app), adds an unverified TOTP factor
// and sends wrong codes to it, in the same two rounds. A round passes when Auth stops it with HTTP 429 (the per-IP limit) or with
// mfa_verification_rejected (the per-account lockout hook, private.mfa_verification_attempt).
// Use a test account, not a real operator's: the lockout keeps it out for 15 minutes.
import { randomInt, randomUUID } from 'node:crypto';

const url = process.env.AUTH_URL;
const apikey = process.env.APIKEY ?? '';
const attempts = Number(process.env.ATTEMPTS ?? 60);
if (!url) {
  console.error('Set AUTH_URL (…/auth/v1) and APIKEY.');
  process.exit(2);
}

const mfa = process.env.MFA_EMAIL;

async function auth(path, body, token) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Signs in and adds a fresh unverified TOTP factor to send wrong codes to. */
async function mfaTarget(email, password) {
  const session = await auth('/token?grant_type=password', { email, password });
  if (!session.ok) {
    console.error(`Could not sign in as ${email}: HTTP ${session.status}`);
    process.exit(2);
  }
  const { access_token: token } = await session.json();
  const factor = await auth(
    '/factors',
    { factor_type: 'totp', friendly_name: `probe-${randomUUID()}` },
    token,
  );
  if (!factor.ok) {
    console.error(`Could not add a TOTP factor (is MFA enabled?): HTTP ${factor.status}`);
    process.exit(2);
  }
  return { token, factorId: (await factor.json()).id };
}

/** One wrong code: returns '429', 'locked' or null (accepted the guess and said it was wrong). */
async function wrongMfaCode(target, headers) {
  const send = (path, body) =>
    fetch(`${url}/factors/${target.factorId}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey,
        authorization: `Bearer ${target.token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const challenge = await send('/challenge', {});
  if (challenge.status === 429) return '429';
  const { id } = await challenge.json();
  const verify = await send('/verify', { challenge_id: id, code: '000000' });
  if (verify.status === 429) return '429';
  const body = await verify.json().catch(() => ({}));
  return body.error_code === 'mfa_verification_rejected' ? 'locked' : null;
}

// Each round signs in again: when the lockout rejects a code, Auth also ends that session.
async function mfaRound(label, headers) {
  const target = await mfaTarget(mfa, process.env.MFA_PASSWORD ?? '');
  for (let i = 1; i <= attempts; i++) {
    const stopped = await wrongMfaCode(target, headers());
    if (stopped) {
      const how = stopped === '429' ? 'HTTP 429' : 'the per-account lockout';
      console.log(`ok   ${label}: stopped by ${how} after ${i} wrong codes`);
      return true;
    }
  }
  console.log(`FAIL ${label}: ${attempts} wrong codes and never stopped`);
  return false;
}

async function round(label, headers) {
  if (mfa) return mfaRound(label, headers);
  const email = `rate-limit-probe-${randomUUID()}@example.invalid`;
  for (let i = 1; i <= attempts; i++) {
    const response = await fetch(`${url}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey, ...headers() },
      body: JSON.stringify({ type: 'email', email, token: '00000000' }),
    });
    if (response.status === 429) {
      console.log(`ok   ${label}: HTTP 429 after ${i} wrong codes`);
      return true;
    }
  }
  console.log(`FAIL ${label}: ${attempts} wrong codes and never HTTP 429`);
  return false;
}

const spoofed = () => ({
  'x-forwarded-for': `198.51.100.${randomInt(1, 255)}`,
  'x-real-ip': `198.51.100.${randomInt(1, 255)}`,
});
const plain = await round('wrong codes from one IP', () => ({}));
const spoof = await round('wrong codes with spoofed forwarding headers', spoofed);
process.exit(plain && spoof ? 0 : 1);

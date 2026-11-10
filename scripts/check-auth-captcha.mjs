// Pre-launch check that Supabase Auth's CAPTCHA is on for every anonymous way in (#76).
// With CAPTCHA on, GoTrue refuses sign-up, password sign-in, sign-in links, password recovery and
// resending a confirmation unless the request carries a token Cloudflare accepts.
//
//   AUTH_URL=https://<ref>.supabase.co/auth/v1 APIKEY=<publishable key> node scripts/check-auth-captcha.mjs
//
// Round 1 sends each request with no token and expects HTTP 400 `captcha_failed`. Round 2 sends a
// made-up token, which makes Auth ask Cloudflare about it, and expects the same refusal: it fails
// when Auth can't reach Cloudflare (HTTP 5xx, which would also stop real sign-ins) and when
// anything is accepted. Every request names an address with no account (and sign-up a password
// Auth rejects as too short), so a deployment with CAPTCHA off creates nothing and sends nothing:
// it just fails the check.
import { randomUUID } from 'node:crypto';

const url = process.env.AUTH_URL;
const apikey = process.env.APIKEY ?? '';
if (!url) {
  console.error('Set AUTH_URL (…/auth/v1) and APIKEY.');
  process.exit(2);
}

const email = () => `captcha-probe-${randomUUID()}@example.invalid`;
const requests = [
  { name: 'sign-up', path: '/signup', body: () => ({ email: email(), password: 'x' }) },
  {
    name: 'password sign-in',
    path: '/token?grant_type=password',
    body: () => ({ email: email(), password: 'not-a-real-password' }),
  },
  { name: 'sign-in link', path: '/otp', body: () => ({ email: email(), create_user: false }) },
  { name: 'password recovery', path: '/recover', body: () => ({ email: email() }) },
  { name: 'magic link', path: '/magiclink', body: () => ({ email: email() }) },
  {
    name: 'resend confirmation',
    path: '/resend',
    body: () => ({ type: 'signup', email: email() }),
  },
];

async function send(request, token) {
  const response = await fetch(`${url}${request.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey },
    body: JSON.stringify({
      ...request.body(),
      ...(token ? { gotrue_meta_security: { captcha_token: token } } : {}),
    }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, code: body.error_code };
}

async function round(label, token) {
  let ok = true;
  for (const request of requests) {
    const { status, code } = await send(request, token);
    const refused = status === 400 && code === 'captcha_failed';
    const note = refused
      ? ''
      : status >= 500
        ? ' (Auth could not check the token: can it reach challenges.cloudflare.com?)'
        : ' (not refused: is CAPTCHA on?)';
    console.log(
      `${refused ? 'ok  ' : 'FAIL'} ${label}, ${request.name}: HTTP ${status} ${code ?? ''}${note}`,
    );
    ok &&= refused;
  }
  return ok;
}

const none = await round('no token', undefined);
const junk = await round('made-up token', 'XXXX.NOT.A.REAL.TOKEN.XXXX');
process.exit(none && junk ? 0 : 1);

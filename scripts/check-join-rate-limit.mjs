// Pre-launch check that the edge limits guest joins, and the join passes (#560) that come
// before them, per client IP (O5, #76). The database's own join limits (per device, network and
// queue) still run under it; this rule turns a flood away at the gateway first.
//
//   API_URL=https://api.<your domain> APIKEY=<publishable key> node scripts/check-join-rate-limit.mjs
//
// Nothing is created: joins name a queue that doesn't exist (the database answers not_found) and
// passes carry a made-up Turnstile token (join-pass answers captcha_required). For each endpoint,
// round 1 sends plain requests and must get 429 within ATTEMPTS (default 45; the rules allow 30 a
// minute). Round 2 sends a different made-up X-Forwarded-For, X-Real-IP and CF-Connecting-IP on
// every request and must be refused at once ("after 1"), or anyone could dodge the rule by
// rotating them. Round 3 tries other spellings of the path, which must be limited or refused,
// never answered. Run it from a machine that isn't on the shop's network: it spends that IP's
// allowance for a minute.
//
// Then, within a minute, run it with --one from a different network (a phone hotspot):
//
//   API_URL=... APIKEY=... node scripts/check-join-rate-limit.mjs --one
//
// That sends one join and one pass, which must get past the gateway, not 429. A 429 there means
// the gateway sees every client as the same address (a proxy in front of Kong without
// KONG_TRUSTED_IPS / KONG_REAL_IP_HEADER), so one flood would block every guest everywhere.
import { randomInt, randomUUID } from 'node:crypto';

const url = process.env.API_URL;
const apikey = process.env.APIKEY ?? '';
const attempts = Number(process.env.ATTEMPTS ?? 45);
if (!url) {
  console.error('Set API_URL (the origin in front of /rest/v1) and APIKEY.');
  process.exit(2);
}

function join(path, headers = {}) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      apikey,
      ...(apikey.startsWith('eyJ') ? { authorization: `Bearer ${apikey}` } : {}),
      'content-type': 'application/json',
      'content-profile': 'api',
      ...headers,
    },
    body: JSON.stringify({
      p_queue_id: randomUUID(),
      p_service_id: null,
      p_name: 'Rate limit probe',
      p_party_size: 1,
      p_phone_e164: null,
      p_email: null,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
    }),
  });
}

/** The Turnstile step before a join (#560). A made-up token that reaches it is refused. */
function pass(path, headers = {}) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token: 'rate-limit-probe' }),
  });
}

/** Each limited endpoint, and the answer that shows a request got past the gateway. */
const endpoints = [
  { name: 'joins', path: '/rest/v1/rpc/join_queue', send: join, reached: 'not_found' },
  { name: 'join passes', path: '/functions/v1/join-pass', send: pass, reached: 'captcha_required' },
];

async function round(endpoint, label, headers) {
  for (let i = 1; i <= attempts; i++) {
    const response = await endpoint.send(endpoint.path, headers());
    if (response.status === 429) {
      console.log(`ok   ${endpoint.name} ${label}: HTTP 429 after ${i}`);
      return true;
    }
  }
  console.log(`FAIL ${endpoint.name} ${label}: ${attempts} requests and never HTTP 429`);
  return false;
}

const spoofed = () => {
  const ip = `198.51.100.${randomInt(1, 255)}`;
  return { 'x-forwarded-for': ip, 'x-real-ip': ip, 'cf-connecting-ip': ip };
};

/** Other spellings of each path; with the limit spent, none may get past the gateway. */
const aliases = {
  '/rest/v1/rpc/join_queue': [
    '/rest/v1//rpc/join_queue',
    '/rest/v1/rpc//join_queue',
    '/rest/v1/./rpc/join_queue',
    '/rest/v1/rpc/join_queue/',
    '/rest/v1/rpc/join_queue?',
    '/rest/v1/rpc/%6Aoin_queue',
    '/rest/v1/rpc/JOIN_QUEUE',
  ],
  '/functions/v1/join-pass': [
    '/functions/v1//join-pass',
    '/functions/v1/./join-pass',
    '/functions/v1/join-pass/',
    '/functions/v1/join-pass?',
    '/functions/v1/%6Aoin-pass',
    '/functions/v1/JOIN-PASS',
  ],
};

async function aliasRound(endpoint) {
  let ok = true;
  for (const path of aliases[endpoint.path]) {
    const response = await endpoint.send(path);
    const body = await response.text();
    const reached = response.status !== 429 && body.includes(endpoint.reached);
    console.log(`${reached ? 'FAIL' : 'ok  '} ${path}: HTTP ${response.status}`);
    ok &&= !reached;
  }
  return ok;
}

if (process.argv.includes('--one')) {
  let ok = true;
  for (const endpoint of endpoints) {
    const response = await endpoint.send(endpoint.path);
    const body = await response.text();
    if (response.status === 429) {
      console.log(
        `FAIL second network, ${endpoint.name}: HTTP 429 at once, so all clients share one limit`,
      );
      ok = false;
      continue;
    }
    const reached = body.includes(endpoint.reached);
    console.log(
      `${reached ? 'ok  ' : 'FAIL'} second network, ${endpoint.name}: HTTP ${response.status}`,
    );
    ok &&= reached;
  }
  process.exit(ok ? 0 : 1);
}

let ok = true;
for (const endpoint of endpoints) {
  ok = (await round(endpoint, 'from one IP', () => ({}))) && ok;
  ok = (await round(endpoint, 'with spoofed client-IP headers', spoofed)) && ok;
  ok = (await aliasRound(endpoint)) && ok;
}
if (ok) console.log('Now run this with --one from a different network within a minute.');
process.exit(ok ? 0 : 1);

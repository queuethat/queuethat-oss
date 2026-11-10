/* global __ENV */
// K1 realtime spike (#28): N anonymous guests hold a socket on qpulse:{pulse_id} and refetch their
// own status 0-1.5 s after each pulse; one staff VU calls next every 10-30 s. See README.md.
//
//   k6 run -e GUESTS=500 -e PULSE_ID=... -e ANON_KEY=... -e SERVICE_KEY=... pulse.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { setInterval, clearInterval, setTimeout } from 'k6/timers';
import { WebSocket } from 'k6/experimental/websockets';

const GUESTS = Number(__ENV.GUESTS || 100);
const RAMP_S = Number(__ENV.RAMP_S || 30); // guests connect evenly over this many seconds
const SETTLE_S = 15; // quiet time between the last join and the first pulse
const WINDOW_S = Number(__ENV.WINDOW_S || 240); // staff calls next during this window
const TAIL_S = 15; // guests stay connected this long after the last possible pulse
const JITTER_MS = 1500;
const BASE = __ENV.API_URL || 'http://127.0.0.1:55321';
const WS_URL = `${BASE.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${__ENV.ANON_KEY}&vsn=1.0.0`;
const TOPIC = `realtime:qpulse:${__ENV.PULSE_ID}`;

const deliveryMs = new Trend('pulse_delivery_ms', true); // commit -> socket message
const refetchMs = new Trend('refetch_ms', true); // RPC round trip alone
const e2eMs = new Trend('event_to_refetch_ms', true); // commit -> guest holds fresh status
const pulsesSent = new Counter('pulses_sent');
const pulsesReceived = new Counter('pulses_received');
const joinsOk = new Counter('joins_ok');
const joinsFailed = new Counter('joins_failed');
const socketErrors = new Counter('socket_errors');
const refetchErrors = new Counter('refetch_errors');
const staleReads = new Counter('stale_reads'); // refetch returned an older version than the pulse

export const options = {
  setupTimeout: '30s',
  scenarios: {
    guests: {
      executor: 'per-vu-iterations',
      exec: 'guest',
      vus: GUESTS,
      iterations: 1,
      maxDuration: `${RAMP_S + SETTLE_S + WINDOW_S + TAIL_S + 60}s`,
    },
    staff: {
      executor: 'constant-vus',
      exec: 'staff',
      vus: 1,
      startTime: `${RAMP_S + SETTLE_S}s`,
      duration: `${WINDOW_S}s`,
      gracefulStop: '0s',
    },
  },
};

export function setup() {
  return { start: Date.now() };
}

export function guest(data) {
  // __VU is shared with the staff scenario, so number guests by their own iteration instead.
  const i = exec.scenario.iterationInTest;
  const token = `lt-${i + 1}`;
  const endAt = data.start + (RAMP_S + SETTLE_S + WINDOW_S + TAIL_S) * 1000;
  sleep((i / GUESTS) * RAMP_S);

  const ws = new WebSocket(WS_URL);
  let ref = 0;
  const send = (topic, event, payload) =>
    ws.readyState === 1 &&
    ws.send(JSON.stringify({ topic, event, payload, ref: String(++ref), join_ref: '1' }));
  let heartbeat;

  ws.onopen = () => {
    send(TOPIC, 'phx_join', {
      config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false },
      access_token: __ENV.ANON_KEY,
    });
    heartbeat = setInterval(() => send('phoenix', 'heartbeat', {}), 25000);
    setTimeout(() => ws.close(), Math.max(0, endAt - Date.now()));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.event === 'phx_reply' && msg.topic === TOPIC && msg.ref === '1') {
      if (msg.payload.status === 'ok') joinsOk.add(1);
      else {
        joinsFailed.add(1);
        console.warn(`join failed: ${JSON.stringify(msg.payload)}`);
      }
      return;
    }
    if (msg.event === 'system' && msg.payload?.status === 'error') {
      console.warn(`system error: ${JSON.stringify(msg.payload)}`);
      return;
    }
    if (msg.event !== 'broadcast' || msg.payload?.event !== 'pulse') return;
    const pulse = msg.payload.payload;
    deliveryMs.add(Date.now() - pulse.sent_at);
    pulsesReceived.add(1);
    setTimeout(() => {
      const res = http.post(
        `${BASE}/rest/v1/rpc/loadtest_visit_status`,
        JSON.stringify({ p_token: token }),
        {
          headers: {
            apikey: __ENV.ANON_KEY,
            'Content-Type': 'application/json',
            'Content-Profile': 'api',
            Accept: 'application/vnd.pgrst.object+json',
          },
          tags: { name: 'refetch' },
        },
      );
      if (res.status !== 200) {
        refetchErrors.add(1);
        console.warn(`refetch ${res.status}: ${res.body}`);
        return;
      }
      refetchMs.add(res.timings.duration);
      e2eMs.add(Date.now() - pulse.sent_at);
      if (res.json('version') < pulse.version) staleReads.add(1);
    }, Math.random() * JITTER_MS);
  };

  ws.onerror = (e) => {
    socketErrors.add(1);
    console.warn(`socket error: ${e.error}`);
  };
  ws.onclose = () => clearInterval(heartbeat);
}

export function staff() {
  const res = http.post(
    `${BASE}/rest/v1/rpc/loadtest_call_next`,
    JSON.stringify({ p_pulse_id: __ENV.PULSE_ID }),
    {
      headers: {
        apikey: __ENV.SERVICE_KEY,
        Authorization: `Bearer ${__ENV.SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Content-Profile': 'api',
      },
      tags: { name: 'call_next' },
    },
  );
  if (check(res, { 'call_next 200': (r) => r.status === 200 })) pulsesSent.add(1);
  sleep(10 + Math.random() * 20);
}

export function handleSummary(data) {
  const m = data.metrics;
  const count = (k) => m[k]?.values.count ?? 0;
  const trend = (k) =>
    m[k] ? { p50: m[k].values.med, p95: m[k].values['p(95)'], max: m[k].values.max } : null;
  const expected = count('pulses_sent') * count('joins_ok');
  const summary = {
    guests: GUESTS,
    joins_ok: count('joins_ok'),
    joins_failed: count('joins_failed'),
    socket_errors: count('socket_errors'),
    pulses_sent: count('pulses_sent'),
    pulses_expected: expected,
    pulses_received: count('pulses_received'),
    drop_rate: expected ? 1 - count('pulses_received') / expected : null,
    refetch_errors: count('refetch_errors'),
    stale_reads: count('stale_reads'),
    pulse_delivery_ms: trend('pulse_delivery_ms'),
    refetch_ms: trend('refetch_ms'),
    event_to_refetch_ms: trend('event_to_refetch_ms'),
  };
  const out = __ENV.SUMMARY_OUT || `results/guests-${GUESTS}.json`;
  return {
    [out]: JSON.stringify(summary, null, 2) + '\n',
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}

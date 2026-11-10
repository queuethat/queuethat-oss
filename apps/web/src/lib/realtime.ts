import type { ConnectionState } from '@qm/ui';
import { RealtimeClient, type RealtimeChannel } from '@supabase/realtime-js';
import { appConfig } from './config.ts';
import type { Pulse } from './live.ts';

// Loaded lazily by live.ts. One socket per page, one channel per topic, shared by every
// useLiveQuery on that topic. A refused or failed join (e.g. the hosted connection cap) reports
// 'offline' and leaves the screen on 30 s polling; realtime-js retries the join itself with
// stepped backoff, so there is no retry loop here.
//
// A socket that stops answering (a dead Wi-Fi link or a proxy that holds it open)
// sends no close. realtime-js notices only when the next heartbeat finds the last one unanswered,
// about 50 s at its defaults. Here a heartbeat goes out every 10 s and one unanswered for 5 s
// marks every channel offline until a heartbeat is answered again (#529), so the screen says it is
// reconnecting within about 15 s and keeps polling meanwhile.

/** How often the socket sends a heartbeat. */
export const HEARTBEAT_MS = 10_000;
/** How long a heartbeat may go unanswered before channels report offline. */
export const HEARTBEAT_GRACE_MS = 5_000;

let client: RealtimeClient | null = null;
type Entry = {
  channel: RealtimeChannel;
  listeners: Set<(p: Pulse) => void>;
  states: Set<(s: ConnectionState) => void>;
  /** What realtime-js last reported for the channel. `state` is offline while the socket is stale. */
  joined: ConnectionState;
  state: ConnectionState;
};
const channels = new Map<string, Entry>();
let stale = false;
let graceTimer: ReturnType<typeof setTimeout> | undefined;

function setStale(next: boolean) {
  if (stale === next) return;
  stale = next;
  channels.forEach((entry) => publish(entry));
}

function publish(entry: Entry) {
  const state = stale ? 'offline' : entry.joined;
  if (state === entry.state) return;
  entry.state = state;
  entry.states.forEach((s) => s(state));
}

function onHeartbeat(status: string) {
  if (status === 'sent') {
    if (graceTimer === undefined) graceTimer = setTimeout(() => setStale(true), HEARTBEAT_GRACE_MS);
    return;
  }
  clearTimeout(graceTimer);
  graceTimer = undefined;
  if (status === 'ok') setStale(false);
}

function socket(): RealtimeClient {
  if (client) return client;
  const { supabaseUrl: url, supabaseAnonKey: key } = appConfig();
  if (!url || !key) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set.');
  client = new RealtimeClient(`${url.replace(/^http/, 'ws')}/realtime/v1`, {
    params: { apikey: key },
    heartbeatIntervalMs: HEARTBEAT_MS,
    heartbeatCallback: onHeartbeat,
  });
  return client;
}

/**
 * Joins as this user from now on, and re-authorizes joined channels. Null (signed out) goes back
 * to the anon key: realtime-js would otherwise keep sending the last user's token.
 */
export function setRealtimeAuth(token: string | null) {
  void socket().setAuth(token ?? (appConfig().supabaseAnonKey || null));
}

export function joinTopic(
  topic: string,
  onPulse: (pulse: Pulse) => void,
  onState: (state: ConnectionState) => void,
): () => void {
  let entry = channels.get(topic);
  if (!entry) {
    const channel = socket().channel(topic, {
      // Both topics are private (V9): on a public channel any subscriber could forge pulses.
      // Guests authorize with the anon key; the realtime.messages policies only allow reading.
      config: { private: true, broadcast: { self: false } },
    });
    const created: Entry = {
      channel,
      listeners: new Set<(p: Pulse) => void>(),
      states: new Set<(s: ConnectionState) => void>(),
      joined: 'connecting',
      state: 'connecting',
    };
    const deliver = ({ payload }: { payload?: unknown }) => {
      const version = Number((payload as Partial<Pulse> | undefined)?.version);
      if (!Number.isFinite(version)) return;
      created.listeners.forEach((l) => l({ ...(payload as Pulse), version }));
    };
    // V9: `pulse` on qpulse: topics, `signal` on loc: topics.
    channel.on('broadcast', { event: 'pulse' }, deliver);
    channel.on('broadcast', { event: 'signal' }, deliver);
    channel.subscribe((status) => {
      created.joined =
        status === 'SUBSCRIBED'
          ? 'live'
          : status === 'TIMED_OUT' || status === 'CHANNEL_ERROR'
            ? 'offline'
            : created.joined === 'live'
              ? 'offline'
              : 'connecting';
      // A join that succeeded proves the socket answers, even before the next heartbeat does.
      if (created.joined === 'live') setStale(false);
      publish(created);
    });
    channels.set(topic, created);
    publish(created);
    entry = created;
  }
  entry.listeners.add(onPulse);
  entry.states.add(onState);
  onState(entry.state);
  const current = entry;
  return () => {
    current.listeners.delete(onPulse);
    current.states.delete(onState);
    if (current.listeners.size === 0) {
      channels.delete(topic);
      void socket().removeChannel(current.channel);
    }
  };
}

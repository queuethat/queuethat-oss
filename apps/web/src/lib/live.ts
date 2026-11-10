import {
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryOptions,
} from '@tanstack/react-query';
import type { ConnectionState } from '@qm/ui';
import { useEffect, useRef, useSyncExternalStore } from 'react';

// L1 (#40): the one live-data pattern (technical-design.md 3.5, "Live data"). Realtime never
// carries data: a pulse on a topic only says "version N exists", and the screen refetches its
// query. Polling every 30 s and refetching on focus/reconnect cover the times the socket is dead
// (iOS kills background sockets), so a dropped channel only makes updates slower, never wrong.

/**
 * A realtime message on a private topic: `pulse` on `qpulse:` ({version, now_serving},
 * docs/architecture I-5) or `signal` on `loc:` ({queue_id, visit_id, version}). `version` is always the
 * queue's version after the change, sent at commit, so it is never older than a refetch.
 */
export interface Pulse {
  version: number;
  now_serving?: string | null;
  queue_id?: string;
  visit_id?: string | null;
}

/** Subscribes to a topic; returns an unsubscribe. Injectable so tests need no socket. */
export type PulseSource = (
  topic: string,
  onPulse: (pulse: Pulse) => void,
  onState: (state: ConnectionState) => void,
) => () => void;

export const POLL_MS = 30_000;
export const GUEST_JITTER_MS = 1_500;
export const STALE_AFTER_MS = 120_000;

type Topics = string | readonly string[] | null;

export interface LiveQueryOptions<T> {
  /**
   * `qpulse:{pulse_id}` for guests and displays, `loc:{location_id}` for staff; null = poll only.
   * Several topics when the data spans queues (the join page). A function derives it from the
   * data, for screens that learn their topic from the first fetch.
   */
  topic: Topics | ((data: T | undefined) => Topics | undefined);
  queryKey: QueryKey;
  queryFn: () => Promise<T>;
  /**
   * The version of the pulse's queue that the data already reflects, read from the fetched data,
   * never from a pulse; pulses below it are dropped. Staff data spans queues, so it gets the pulse to look up `queue_id`.
   */
  versionOf?: (data: T, pulse: Pulse) => number | null | undefined;
  /**
   * Upper bound of the random delay before refetching. Guests use the default so a busy
   * queue's pulse doesn't make every phone hit the database in the same millisecond; staff pass 0.
   */
  jitterMs?: number;
  enabled?: boolean;
  /**
   * How often to poll, from the latest data; POLL_MS when left out. For a screen that must not
   * miss a change by a full poll when one pulse is lost (realtime is at-most-once).
   */
  pollMs?: (data: T | undefined) => number;
  /** As useQuery's; e.g. don't retry an answer that is final, like an unknown link. */
  retry?: UseQueryOptions<T>['retry'];
  source?: PulseSource;
}

/**
 * useQuery that stays current: refetches on each newer pulse (after jitter), every 30 s (or
 * `pollMs`), when the
 * tab becomes visible and when the network returns. Screens use this and never touch channels.
 */
export function useLiveQuery<T>({
  topic,
  queryKey,
  queryFn,
  versionOf,
  jitterMs = GUEST_JITTER_MS,
  enabled = true,
  pollMs,
  retry,
  source = realtimeSource,
}: LiveQueryOptions<T>) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    ...(retry === undefined ? {} : { retry }),
    refetchInterval: pollMs ? (q) => pollMs(q.state.data) : POLL_MS,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const resolved = (typeof topic === 'function' ? topic(query.data) : topic) ?? null;
  // A stable key, so a new array with the same topics doesn't resubscribe.
  const topicKey = (typeof resolved === 'string' ? [resolved] : (resolved ?? [])).join(' ');
  // Latest values for the subscription callback, which outlives renders.
  const latest = useRef({ queryKey, versionOf });
  useEffect(() => {
    latest.current = { queryKey, versionOf };
  });

  useEffect(() => {
    const topics = topicKey ? topicKey.split(' ') : [];
    if (topics.length === 0 || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refetching = false;
    let again = false;
    // One refetch at a time per query. A pulse that arrives while one is in flight must not cancel
    // it: staff share one `loc:` topic with every tablet at the location, and pulses coming
    // faster than a refetch takes would cancel every answer before it landed. The change the
    // pulse announces may postdate the request in flight (ours, a poll's or a mutation's), so
    // one more refetch follows it.
    const refetch = () => {
      if (refetching) {
        again = true;
        return;
      }
      refetching = true;
      const { queryKey: key } = latest.current;
      const joined = queryClient.isFetching({ queryKey: key, exact: true }) > 0;
      void queryClient
        .invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false })
        .finally(() => {
          refetching = false;
          // After joining a fetch that was already running, the next call starts a fetch of ours.
          if (again || joined) {
            again = false;
            refetch();
          }
        });
    };
    const onPulse = (pulse: Pulse) => {
      const { queryKey: key, versionOf: version } = latest.current;
      const cached = queryClient.getQueryData<T>(key);
      const have = cached === undefined ? null : version?.(cached, pulse);
      // Equal still refetches: a change can land without bumping the queue version (V9).
      if (have != null && pulse.version < have) return;
      if (timer) return; // a refetch is already scheduled; it will see this version too
      timer = setTimeout(() => {
        timer = undefined;
        refetch();
      }, Math.random() * jitterMs);
    };
    // Realtime is at-most-once and a channel takes a moment to join, so a change committed after
    // the first fetch but before the join is never announced. Each time a topic becomes live, one
    // refetch catches up on whatever it missed (the first join, and every reconnect).
    const wasLive = new Map<string, boolean>();
    const leave = topics.map((topic) =>
      source(topic, onPulse, (state) => {
        connection.set(topic, state);
        const live = state === 'live';
        if (live && !wasLive.get(topic) && !timer) {
          timer = setTimeout(() => {
            timer = undefined;
            refetch();
          }, Math.random() * jitterMs);
        }
        wasLive.set(topic, live);
      }),
    );
    return () => {
      clearTimeout(timer);
      again = false;
      leave.forEach((unsubscribe) => unsubscribe());
      topics.forEach((topic) => connection.set(topic, null));
    };
  }, [topicKey, enabled, jitterMs, source, queryClient]);

  return query;
}

// Times the page went from live to not live because a live topic dropped (a topic that is still
// connecting for the first time doesn't count). Read by the device heartbeat.
let drops = 0;

// Connection state across every live topic on the page: the worst one wins.
const connection = (() => {
  const states = new Map<string, ConnectionState>();
  const listeners = new Set<() => void>();
  let snapshot: ConnectionState = 'live';
  const rank: Record<ConnectionState, number> = { live: 0, connecting: 1, offline: 2 };
  return {
    set(topic: string, state: ConnectionState | null) {
      if (snapshot === 'live' && states.get(topic) === 'live' && state && state !== 'live') {
        drops++;
      }
      if (state) states.set(topic, state);
      else states.delete(topic);
      snapshot = [...states.values()].reduce<ConnectionState>(
        (worst, s) => (rank[s] > rank[worst] ? s : worst),
        'live',
      );
      listeners.forEach((l) => l());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      window.addEventListener('online', listener);
      window.addEventListener('offline', listener);
      return () => {
        listeners.delete(listener);
        window.removeEventListener('online', listener);
        window.removeEventListener('offline', listener);
      };
    },
    get: (): ConnectionState => (navigator.onLine ? snapshot : 'offline'),
  };
})();

/**
 * How many times live updates stopped arriving since the last `ack`. A caller that reports the
 * count acks what it sent once the report succeeds, so a failed report loses nothing.
 */
export const liveDrops = {
  count: (): number => drops,
  ack(sent: number) {
    drops = Math.max(0, drops - sent);
  },
};

/** Whether live updates are arriving, for ConnectionIndicator. Offline whenever the browser is. */
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.get, () => 'live');
}

/** True when the last successful fetch is over 2 minutes old: show "as of", grey the ETA. */
export function isStale(dataUpdatedAt: number, now: number = Date.now()): boolean {
  return dataUpdatedAt > 0 && now - dataUpdatedAt > STALE_AFTER_MS;
}

/**
 * The server's `as_of` as "HH:MM" in `timeZone` (an IANA name such as the location's tz, I-6),
 * or in the device's zone when none is given. Clients never count down from it (G-13).
 */
export function formatAsOf(asOf: string, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone }).format(
    new Date(asOf),
  );
}

let liveToken: string | null = null;
let applyToken: ((token: string | null) => void) | null = null;

/**
 * The signed-in user's access token, so private `loc:` topics authorize as that user. The auth
 * module keeps it current (sign-in, refresh, sign-out); guests never set it and join as anon.
 */
export function setLiveAuth(token: string | null) {
  liveToken = token;
  applyToken?.(token);
}

/**
 * Supabase Realtime broadcast. realtime-js is imported on first use, so guest pages render (and
 * poll) without paying for it up front. Channels are shared per topic.
 */
export const realtimeSource: PulseSource = (topic, onPulse, onState) => {
  let closed = false;
  let leave = () => {};
  onState('connecting');
  void import('./realtime.ts').then(({ joinTopic, setRealtimeAuth }) => {
    if (!applyToken) {
      applyToken = setRealtimeAuth;
      // Before the first join: a channel sends whatever token the socket holds when it joins.
      if (liveToken) setRealtimeAuth(liveToken);
    }
    if (closed) return;
    leave = joinTopic(topic, onPulse, onState);
  });
  return () => {
    closed = true;
    leave();
  };
};

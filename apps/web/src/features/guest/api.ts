import { errorCode } from '@qm/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { POLL_MS, useLiveQuery } from '../../lib/live.ts';
import { joinProvider, publicJoin, type Geo } from './captcha/publicJoin.ts';
import { guestFunction, guestRpc } from './client.ts';
import { parseJoinForm } from './formFields.ts';
import { forgetPushVisit, type PushStep, rememberPushVisit, subscribeToPush } from './push.ts';

// Guest data access: one query-options factory and one hook per RPC (apps/web/README.md).

/** Answers to a form by field key, as `p_answers` takes them (multi_choice is a list of options, a signature is `{name, guardian_name?}`). */
export type Answers = Record<
  string,
  string | number | boolean | string[] | { name: string; guardian_name?: string }
>;

/**
 * The form a guest fills for (queue, service) on a channel: `{form_version_id, fields}` from
 * `get_join_form`, parsed by `parseJoinForm`. The service is chosen before this is asked, so a
 * service's own form wins over the queue's. Nothing here says whether an answer is valid; the
 * join or `set_booking_answers` call does, and names the failing key.
 */
export function useJoinForm(
  queueId: string | null,
  serviceId: string | null,
  channel: 'walk_in' | 'booking',
) {
  return useQuery({
    enabled: queueId !== null,
    queryKey: ['guest', 'join-form', queueId, serviceId, channel],
    queryFn: async () =>
      parseJoinForm(
        await guestRpc('get_join_form', {
          p_queue_id: queueId,
          p_service_id: serviceId,
          p_channel: channel,
        }),
      ),
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
  });
}

/** Saves a booking's answers (`set_booking_answers`), which is where required ones are enforced. */
export function useSetBookingAnswers() {
  return useMutation({
    mutationFn: ({ token, answers }: { token: string; answers: Answers }) =>
      guestRpc('set_booking_answers', { p_token: token, p_answers: answers }),
  });
}

/**
 * The public view of a location and its queues, by the slug printed on its poster. Kept live by
 * the pulse of one queue only: `queueId`, or the first queue while none is picked, the one the
 * form would join. A socket allows at most 100 channels and every subscriber pays for each
 * queue's fan-out, so the other queues refresh on the 30 s poll and when the tab regains focus
 * (#566). Joining is checked by the database anyway (I-8), so a stale count is only cosmetic.
 */
export function useLocationPublic(slug: string, queueId: string | null = null) {
  return useLiveQuery({
    topic: (location) => {
      const queues = location?.queues ?? [];
      const queue = queues.find((q) => q.id === queueId) ?? queues[0];
      return queue?.pulse_id ? `qpulse:${queue.pulse_id}` : null;
    },
    queryKey: ['guest', 'location', slug],
    queryFn: () => guestRpc('get_location_public', { p_location_slug: slug }),
    // An unknown slug is final; retrying only delays the "not found" page.
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
  });
}

/**
 * The wait a guest joining each queue of the location would get, plus when a closed location
 * opens (G-14). It has no channel of its own: the join page already follows the picked queue's
 * pulse through useLocationPublic, so a new answer there (`publicUpdatedAt`) refetches this too,
 * and a second subscription to one topic is avoided.
 */
export function useLocationWait(slug: string, publicUpdatedAt: number) {
  const query = useQuery({
    queryKey: ['guest', 'location-wait', slug],
    queryFn: () => guestRpc('get_location_wait', { p_location_slug: slug }),
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const { refetch } = query;
  useEffect(() => {
    if (publicUpdatedAt > 0) void refetch();
  }, [publicUpdatedAt, refetch]);
  return query;
}

/**
 * The picker's lines (M5): the location's provider lines and "Anyone available" pool, or no rows
 * when it has none. `forLine` is the `?for=` value from the link, passed through untouched: the
 * database says which row it names (`selected`) and ignores anything that names no line here.
 * It has no pulse of its own (the join page follows one queue's); it refreshes on the 30 s poll and
 * when the tab regains focus, and joining is checked by the database anyway, so a stale count is cosmetic.
 * `live = false` skips the poll for pages that only need the names (the booking page, M7).
 */
export function useLocationLines(slug: string, forLine: string | null, live = true) {
  return useQuery({
    queryKey: ['guest', 'location-lines', slug, forLine],
    queryFn: () => guestRpc('get_location_lines', { p_location_slug: slug, p_for: forLine }),
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
    refetchInterval: live ? POLL_MS : false,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
}

/** How often the guest who is next polls, so a lost pulse delays "you're up" by 5 s, not 30 (#548). */
export const NEXT_POLL_MS = 5_000;

/** The poll interval for a visit status: 5 s while waiting with nobody ahead, else 30 s. */
export function visitPollMs(
  visit: { status: string | null; people_ahead: number | null } | undefined,
): number {
  return visit?.status === 'waiting' && visit.people_ahead === 0 ? NEXT_POLL_MS : POLL_MS;
}

/**
 * A visit by its link token, kept live by the queue's public pulse. Pulses carry the queue
 * version and the status carries the visit's, so every pulse refetches (jittered); that is one
 * small call per guest per queue change. A waiting guest with nobody ahead (as the database
 * reports it) also polls every 5 s, so missing the call's pulse costs seconds, not a turn.
 */
export function useVisitStatus(token: string) {
  return useLiveQuery({
    pollMs: visitPollMs,
    // The pulse topic comes with the first answer.
    topic: (visit) => visit?.queue_pulse_id && `qpulse:${visit.queue_pulse_id}`,
    queryKey: ['guest', 'visit', token],
    queryFn: () => guestRpc('get_visit_status', { p_token: token }),
    // An unknown or expired link is final; retrying only kept the guest on a spinner for ~7 s.
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
  });
}

/**
 * The static details of a visit: where the place is, how to reach it, today's hours and the scan
 * code staff scan at the door. They change rarely, so no pulse: a slow poll and a refetch when the
 * tab regains focus are enough.
 */
export function useVisitInfo(token: string) {
  return useQuery({
    queryKey: ['guest', 'visit-info', token],
    queryFn: () => guestRpc('get_visit_info', { p_token: token }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
  });
}

const ENDED = new Set(['served', 'no_show', 'cancelled', 'removed', 'expired']);

/** Whether a visit status is final: the guest's link shows a closing message, nothing live. */
export function visitEnded(status: string): boolean {
  return ENDED.has(status);
}

/**
 * Turns on "alert me when it's my turn" for a visit: asks permission, subscribes this browser and
 * registers the subscription with api.guest_register_push (repeats are no-ops). `mutate(onStep)`
 * reports which wait the browser is in. Rejects with Error('denied'), Error('no_worker'),
 * Error('timeout') or the RPC's error.
 */
export function useEnablePush(token: string) {
  return useMutation({
    mutationFn: async (onStep?: (step: PushStep) => void) => {
      const keys = await subscribeToPush(onStep);
      await guestRpc('guest_register_push', {
        p_token: token,
        p_endpoint: keys.endpoint,
        p_p256dh: keys.p256dh,
        p_auth: keys.auth,
      });
      await rememberPushVisit(token);
      store(`qm:push:${token}`, '1');
    },
  });
}

/** True once this browser turned alerts on for the visit. */
export function pushEnabled(token: string): boolean {
  return read(`qm:push:${token}`) === '1';
}

/**
 * Drops the saved link for a visit that has ended, so a shared phone doesn't keep the previous
 * guest's page (#445 review). The token is still in the address bar and history; that is the
 * cost of a link that works from a text message.
 */
export function forgetVisit(token: string) {
  // A group's page is reachable from any member who has not been forgotten yet.
  const next = groupMembers(token).find(
    (m) => m.token !== token && read(`qm:group:${m.token}`) !== null,
  );
  try {
    for (const name of Object.keys(localStorage)) {
      if (name.startsWith('qm:visit:') && localStorage.getItem(name) === token) {
        if (next) localStorage.setItem(name, next.token);
        else localStorage.removeItem(name);
      }
    }
    localStorage.removeItem(`qm:push:${token}`);
    localStorage.removeItem(`qm:consent-failed:${token}`);
    localStorage.removeItem(`qm:group:${token}`);
  } catch {
    // storage unavailable: nothing was saved either
  }
  void forgetPushVisit(token);
}

export interface JoinInput {
  /** Null for a location-level join: the database picks the queue from the routing rules (Q-11). */
  queueId: string | null;
  locationId?: string;
  serviceId: string | null;
  name: string;
  phoneE164: string | null;
  /** Optional: the visit's service messages go here (decision 20). Blank counts as not given. */
  email: string | null;
  locale: string;
  /** People in the visit, within the queue's bounds; 1 when the queue doesn't ask (2A-Q9). */
  partySize?: number;
  /** Answers to the queue's intake questions by field key; the database validates them (Q-8). */
  answers?: Answers;
  /** The code on the waiting-room screen, when the location asks for one (2A-JN5). */
  onsiteCode?: string | null;
  /** The guest's position, for a queue that asks to be on site (2B-Q10). Public join only. */
  geo?: Geo | null;
  /** Where the link came from (`?src=`, 2B-J8); public-join keeps allowlisted values only. */
  src?: string | null;
  /** The Turnstile widget's token, when the location asks for one (captcha_site_key). */
  captchaToken?: string | null;
  /** Several people joining together (2A-J15B): one key for the group, each person's own position. */
  group?: { key: string; index: number } | null;
  /** Join for later (J-13): when the guest enters the line (ISO). */
  arriveAfter?: string | null;
}

// Turnstile token → join pass. A token verifies only once, so a retry after a lost join answer
// reuses its pass, which join_queue accepts again for the same idempotency key.
const passes = new Map<string, string>();

export async function joinPass(token: string): Promise<string> {
  const known = passes.get(token);
  if (known) return known;
  const { pass } = (await guestFunction('join-pass', { token })) as { pass: string };
  passes.set(token, pass);
  return pass;
}

/** The key a join's saved state is filed under: its queue, else `loc:` and its location. */
export function joinScope(input: Pick<JoinInput, 'queueId' | 'locationId'>): string {
  return input.queueId ?? `loc:${input.locationId}`;
}

/**
 * Joins a queue. The idempotency key lives in localStorage per queue until a token comes back,
 * so a double tap, a retry or a reload after a lost response all land on the same visit. The
 * device key stays for good: while this phone has an active visit on the queue, joining again
 * returns that visit and its link instead of a second ticket (#474).
 */
export function useJoinQueue() {
  return useMutation({
    mutationFn: async (input: JoinInput) => {
      const provider = joinProvider();
      // What this phone's saved join key and link are filed under: the queue, or the location.
      const scope = joinScope(input);
      const result = provider
        ? // Through the public-join Edge Function: it checks the CAPTCHA and the per-IP limits.
          await publicJoin({
            queueId: input.queueId,
            ...(input.locationId ? { locationId: input.locationId } : {}),
            ...(input.arriveAfter ? { arriveAfter: input.arriveAfter } : {}),
            serviceId: input.serviceId,
            name: input.name,
            phone: input.phoneE164,
            email: input.email,
            partySize: input.partySize ?? 1,
            locale: input.locale,
            idempotencyKey: joinKey(scope, input.group?.index ?? 0),
            groupKey: input.group?.key ?? null,
            deviceKey: deviceKey(),
            onsiteCode: input.onsiteCode ?? null,
            geo: input.geo ?? null,
            src: input.src ?? null,
            answers: input.answers ?? {},
            captcha: input.captchaToken ?? '',
          })
        : await guestRpc('join_queue', {
            p_queue_id: input.queueId,
            ...(input.locationId ? { p_location_id: input.locationId } : {}),
            ...(input.arriveAfter ? { p_arrive_after: input.arriveAfter } : {}),
            p_service_id: input.serviceId,
            p_name: input.name,
            p_phone_e164: input.phoneE164,
            p_email: input.email,
            p_party_size: input.partySize ?? 1,
            p_locale: input.locale,
            p_idempotency_key: joinKey(scope, input.group?.index ?? 0),
            p_group_key: input.group?.key ?? null,
            p_device_key: deviceKey(),
            p_join_pass: input.captchaToken ? await joinPass(input.captchaToken) : null,
            p_onsite_code: input.onsiteCode ?? null,
            p_answers: input.answers ?? {},
          });
      // The key is spent: keeping it would replay the same answer on every later join from this
      // phone, after the visit has ended.
      store(joinKeyName(scope, input.group?.index ?? 0), null);
      // A group's links are saved together by rememberGroup once everyone has joined: saving the
      // first now would send the join page to its status page before the others are in.
      if (input.group) return result;
      if (result.token) store(`qm:visit:${scope}`, result.token);
      // Replays return the token too; null only for a visit from before that (or a staff add),
      // where the page can only show the ticket.
      return { ...result, token: result.token ?? read(`qm:visit:${scope}`) };
    },
  });
}

/**
 * The link saved for the first of these queues that has one, while its visit has not ended,
 * else null (an ended or unknown visit's link is dropped). Lets the join page send a returning
 * guest back to their status page instead of the form.
 */
export function useActiveVisit(queueIds: readonly (string | null)[]) {
  const token = queueIds.map((id) => id && read(`qm:visit:${id}`)).find(Boolean) ?? null;
  return useQuery({
    queryKey: ['guest', 'active-visit', token],
    enabled: token !== null,
    retry: false,
    queryFn: async () => {
      try {
        const visit = await guestRpc('get_visit_status', { p_token: token! });
        if (visit.status && !visitEnded(visit.status)) return token;
      } catch (error) {
        // Only a link the database no longer knows is dropped; a network error keeps it.
        if (errorCode(error) !== 'not_found') throw error;
      }
      forgetVisit(token!);
      return null;
    },
  });
}

/** What this phone has saved links under: queue ids, or `loc:<id>` for a location-level join. */
export function savedVisitScopes(): string[] {
  try {
    return Object.keys(localStorage)
      .filter((name) => name.startsWith('qm:visit:'))
      .map((name) => name.slice('qm:visit:'.length));
  } catch {
    return [];
  }
}

/** This browser's join device key: 16 random bytes, base64url, made once and kept. */
function deviceKey(): string | null {
  const existing = read('qm:device');
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const fresh = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  store('qm:device', fresh);
  // Storage refused: send none rather than a key that changes on every join.
  return read('qm:device');
}

/**
 * Leaves the line (G5, #55) via api.guest_act. Leaving twice is a no-op in the database, so a
 * retry after a lost answer is safe; the answer replaces the live status at once.
 */
export function useLeaveQueue(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      guestRpc('guest_act', { p_token: token, p_action: 'leave', p_idempotency_key: uuid() }),
    onSuccess: (visit) => queryClient.setQueryData(['guest', 'visit', token], visit),
  });
}

/**
 * Takes back a leave (#528) via api.guest_act `undo_leave`: the guest returns to their old place.
 * Offered only while `guest_actions` contains it; a repeat is a no-op, so a retry is safe.
 */
export function useUndoLeave(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      guestRpc('guest_act', { p_token: token, p_action: 'undo_leave', p_idempotency_key: uuid() }),
    onSuccess: (visit) => queryClient.setQueryData(['guest', 'visit', token], visit),
  });
}

/**
 * "I'm on my way" and "I need more time" (G-4) via api.guest_act. One key per tap, kept until the
 * database answers, so a retry after a lost answer is the same tap and never a second snooze. The
 * answer replaces the live status at once; a refused snooze (`snooze_limit_reached`) leaves it as is.
 */
export function useGuestAct(token: string) {
  const queryClient = useQueryClient();
  const key = useRef(uuid());
  return useMutation({
    mutationFn: (action: 'on_my_way' | 'need_more_time') =>
      guestRpc('guest_act', { p_token: token, p_action: action, p_idempotency_key: key.current }),
    onSuccess: (visit) => {
      key.current = uuid();
      queryClient.setQueryData(['guest', 'visit', token], visit);
    },
  });
}

/**
 * Companions (J-14) via api.guest_add_companion / guest_remove_companion. Both answer with the new
 * status, which replaces the live one at once. Adding keeps one key per tap, so a retry after a lost
 * answer is the same companion; `party_limit` and `party_size_out_of_range` are shown by the caller.
 */
export function useCompanions(token: string) {
  const queryClient = useQueryClient();
  const settle = (visit: unknown) => queryClient.setQueryData(['guest', 'visit', token], visit);
  const add = useMutation({
    mutationFn: (firstName: string) =>
      guestRpc('guest_add_companion', {
        p_token: token,
        p_first_name: firstName,
        p_idempotency_key: uuid(),
      }),
    onSuccess: settle,
  });
  const remove = useMutation({
    mutationFn: (companionId: string) =>
      guestRpc('guest_remove_companion', { p_token: token, p_companion_id: companionId }),
    onSuccess: settle,
  });
  return { add, remove };
}

/**
 * The visit's chat (G-15). Messages are fetched through the token, re-read whenever the status's
 * `chat_version` (the highest message id) moves, so a reply shows as soon as the live status
 * refetches; listing marks staff messages read. One key per send, kept until the database answers.
 */
export function useChat(token: string, chatVersion: number | null) {
  const queryClient = useQueryClient();
  const key = useRef(uuid());
  const messages = useQuery({
    queryKey: ['guest', 'chat', token, chatVersion],
    queryFn: () => guestRpc('guest_list_messages', { p_token: token, p_after_id: 0 }),
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
  });
  const send = useMutation({
    mutationFn: (body: string) =>
      guestRpc('guest_send_message', {
        p_token: token,
        p_body: body,
        p_idempotency_key: key.current,
      }),
    onSuccess: () => {
      key.current = uuid();
      return queryClient.invalidateQueries({ queryKey: ['guest', 'chat', token] });
    },
  });
  return { messages, send };
}

/**
 * Post-visit feedback (G-11) via api.guest_submit_feedback. One key per page load: a resend after
 * a lost answer is the same submission, and a second one is `already_submitted`, not an error.
 * `not_found` means feedback is off for this business or the 24 hours are over.
 */
export function useSubmitFeedback(token: string) {
  const key = useRef(uuid());
  return useMutation({
    mutationFn: (input: { rating: number; comment: string }) =>
      guestRpc('guest_submit_feedback', {
        p_token: token,
        p_rating: input.rating,
        p_nps: null,
        p_comment: input.comment.trim() || null,
        p_idempotency_key: key.current,
      }),
  });
}

/** Which alerts the visit sends and which it can choose from (N-17). Not live: only the guest changes them. */
export function useAlertPrefs(token: string) {
  return useQuery({
    queryKey: ['guest', 'alert-prefs', token],
    queryFn: () => guestRpc('guest_get_alert_prefs', { p_token: token }),
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
  });
}

/** Saves the guest's chosen alerts; the answer replaces the cache so the page shows what the database kept. */
export function useSetAlertPrefs(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggers: string[]) =>
      guestRpc('guest_set_alert_prefs', {
        p_token: token,
        p_triggers: triggers,
        p_idempotency_key: uuid(),
      }),
    onSuccess: (prefs) => queryClient.setQueryData(['guest', 'alert-prefs', token], prefs),
  });
}

/** Remembers the poster page this browser last joined from, for "Join again" after a visit. */
export function rememberJoinPage(slug: string) {
  store('qm:join-page', slug);
}

/** The join page this browser last used, or null (a link opened from a text message). */
export function lastJoinPage(): string | null {
  return read('qm:join-page');
}

function joinKeyName(queueId: string, index: number): string {
  return index === 0 ? `qm:join-key:${queueId}` : `qm:join-key:${queueId}:${index}`;
}

function joinKey(queueId: string, index: number): string {
  const existing = read(joinKeyName(queueId, index));
  if (existing) return existing;
  const fresh = uuid();
  store(joinKeyName(queueId, index), fresh);
  return fresh;
}

/**
 * The key linking the visits of the group being joined on this queue. Kept until the group is
 * saved, so a reload and a resubmit replay the same visits instead of making new ones.
 */
export function groupKeyFor(queueId: string): string {
  const existing = read(`qm:group-key:${queueId}`);
  if (existing) return existing;
  const fresh = uuid();
  store(`qm:group-key:${queueId}`, fresh);
  return fresh;
}

/** One person of a group: the link to their status page and the name shown on their tab. */
export interface GroupMember {
  token: string;
  name: string;
}

/**
 * Saves a finished group: the first person's link is the one the join page returns to, and every
 * member's page can list the whole group. Tokens stay on this device only.
 */
export function rememberGroup(queueId: string, members: GroupMember[]) {
  const first = members[0];
  if (!first) return;
  store(`qm:visit:${queueId}`, first.token);
  store(`qm:group-key:${queueId}`, null);
  for (const member of members) store(`qm:group:${member.token}`, JSON.stringify(members));
}

/** The people who joined together with this visit, or an empty list for a single join. */
export function groupMembers(token: string): GroupMember[] {
  try {
    const list: unknown = JSON.parse(read(`qm:group:${token}`) ?? 'null');
    return Array.isArray(list) && list.length > 1 ? (list as GroupMember[]) : [];
  } catch {
    return [];
  }
}

// Storage can throw (private mode, blocked site data); joining must still work, just without
// protection across reloads.
export function read(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

export function store(name: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch {
    // ignored, see read()
  }
}

/** crypto.randomUUID is missing on plain-http LAN addresses, which is how phones hit a dev box. */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Stops the venue's email to the address a message went to, from the signed link in that message
 * (`n` outbox id, `t` token). Repeating it is harmless; a tampered link fails with invalid_input.
 */
export function useUnsubscribe() {
  return useMutation({
    mutationFn: (link: { n: string; t: string }) => guestFunction('unsubscribe', link),
  });
}

/**
 * Mints a single-use Telegram link for the visit (`guest_create_link_code`, N-3) and returns the
 * `t.me` deep link; the bot's webhook completes the link when the guest taps Start. Rejects with
 * `invalid_input` when the deployment has no bot configured.
 */
export function useTelegramLink(token: string) {
  return useMutation({
    mutationFn: async (): Promise<string> => {
      const link = await guestRpc('guest_create_link_code', {
        p_token: token,
        p_channel: 'telegram',
      });
      if (!link.deep_link) throw new Error('invalid_input');
      return link.deep_link;
    },
  });
}

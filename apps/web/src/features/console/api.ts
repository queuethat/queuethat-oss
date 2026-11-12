import type { Database } from '@qm/db-types';
import { errorCode } from '@qm/domain';
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useLiveQuery } from '../../lib/live.ts';
import { supabase } from '../../lib/supabase.ts';
import { callOrQueue } from './offline/queue.ts';

export interface ConsoleQueue {
  id: string;
  name: string;
  /** What staff last set: open, paused or closed. Hours and capacity are the database's call. */
  manualState: 'open' | 'paused' | 'closed';
  /**
   * While the queue is at its hourly online-join ceiling, when online joins open again (ISO);
   * null otherwise. The database owns the rule; every join bumps `version`, so it stays live.
   */
  onlineJoinsPausedUntil: string | null;
  version: number;
  /** A staff-set "current wait" (W-5) and when it expires; null when none is set. */
  waitOverrideMinutes: number | null;
  waitOverrideUntil: string | null;
  /** Admin-set minutes into service before staff are nudged; null lets the default decide. */
  servingReminderMinutes: number | null;
  /** Active services, in display order, for the add-guest dialog. */
  services: { id: string; name: string }[];
  /** M4: `provider` is one person's line, `pool` the shared "Anyone available" line. */
  kind: 'general' | 'provider' | 'pool';
  /** For a provider line, the pool Call next falls back to once the line is empty. */
  pullsFrom: string | null;
}

/**
 * The location's queues for the console tabs, read under RLS and kept live by the location's
 * private `loc:` signal, so a queue paused from another tablet shows here too.
 */
export function useConsoleQueues(locationId: string | undefined) {
  return useLiveQuery({
    topic: locationId ? `loc:${locationId}` : null,
    queryKey: ['console', 'queues', locationId],
    queryFn: async (): Promise<ConsoleQueue[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('queues')
        .select(
          'id, name, manual_state, version, online_joins_paused_until, wait_override_minutes, wait_override_until, serving_reminder_minutes, kind, pulls_from, services(id, name, active, sort_order)',
        )
        .eq('location_id', locationId!)
        .is('archived_at', null)
        .order('sort_order')
        .order('name');
      if (error) throw error;
      return data.map((q) => ({
        id: q.id,
        name: q.name,
        manualState: q.manual_state,
        onlineJoinsPausedUntil: q.online_joins_paused_until,
        version: q.version,
        waitOverrideMinutes: q.wait_override_minutes,
        waitOverrideUntil: q.wait_override_until,
        servingReminderMinutes: q.serving_reminder_minutes,
        services: q.services
          .filter((s) => s.active)
          .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
          .map(({ id, name }) => ({ id, name })),
        kind: q.kind as ConsoleQueue['kind'],
        pullsFrom: q.pulls_from,
      }));
    },
    // Staff see changes at once; jitter only spreads guest load.
    jitterMs: 0,
    versionOf: (queues, pulse) => queues.find((q) => q.id === pulse.queue_id)?.version,
    enabled: !!locationId,
  });
}

/**
 * Opens, pauses or closes a queue through `api.set_queue_state`, which applies it to every entry
 * point at once and keeps waiting guests either way. Setting the current state again is a no-op.
 * Rejects with Error(<error code>), e.g. `not_found` or `org_suspended`.
 */
export function useSetQueueState(locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      queueId,
      state,
    }: {
      queueId: string;
      state: ConsoleQueue['manualState'];
    }) => {
      const { error } = await supabase.rpc('set_queue_state', {
        p_queue_id: queueId,
        p_state: state,
      });
      if (error) throw new Error(errorCode(error));
    },
    // The live signal brings it too; this makes the tablet that tapped update at once.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['console', 'queues', locationId] }),
  });
}

/**
 * Resources at a location that staff can serve from (2A-Q3): the active counters, desks, rooms,
 * tables and chairs, and the signed-in operator's own staff resource. Other people's staff
 * resources are not offered.
 */
export const countersQuery = (locationId: string) =>
  queryOptions({
    queryKey: ['console', 'counters', locationId],
    queryFn: async () => {
      const { data: session } = await supabase.auth.getSession();
      const me = session.session?.user.id ?? '';
      const { data, error } = await supabase
        .schema('app')
        .from('counters')
        .select('id, label')
        .eq('location_id', locationId)
        .is('archived_at', null)
        .eq('active', true)
        .or(`kind.neq.staff,member_user_id.eq.${me}`)
        .order('sort_order')
        // Ties keep the order the counters were added in.
        .order('created_at')
        .order('label');
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
  });

/**
 * The visit states the console lists, in section order (expected guests are appointments not yet
 * checked in). Finished visits drop off, except
 * no-shows from the last two hours, so a guest who turns up late can be reinstated.
 */
export const ACTIVE_STATES = ['waiting', 'called', 'serving', 'expected', 'no_show'] as const;
export type ActiveState = (typeof ACTIVE_STATES)[number];
export const NO_SHOW_WINDOW_MS = 2 * 60 * 60_000;

export interface ConsoleVisit {
  id: string;
  queueId: string;
  ticket: string;
  status: ActiveState;
  name: string | null;
  partySize: number;
  /** Visits that joined together share a key (2A-J15B); null for a single join. */
  groupKey: string | null;
  /** The service's expected minutes, the basis of the serving-too-long reminder (#144). */
  expectedMinutes: number | null;
  /** The guest said they are on the way for this call (from the database, never worked out here). */
  onTheWay: boolean;
  /** The queue the visit's journey sends it to next; null when there is none (from the database). */
  journeyNextQueueId?: string | null;
  /** The guest this visit belongs to, when it has contact details; null for an anonymous walk-in. */
  guestId: string | null;
  service: string | null;
  counter: string | null;
  /** Where the visit came from (`online`, `staff`, `kiosk`, `appointment`). */
  source: string;
  /** The appointment time of an expected or checked-in appointment visit (ISO); null for walk-ins. */
  scheduledAt: string | null;
  /**
   * Before this instant an expected guest is early, after `lateAfter` late, between on time. The
   * database computes both from the queue's knobs (ADR 0010); the console only compares them to
   * the clock.
   */
  earlyUntil: string | null;
  lateAfter: string | null;
  /** When the visit entered its current section: joined, called, started or, for expected, due. */
  since: string;
  /** When the guest joined; places walk-ins on the day's timeline. */
  joinedAt: string;
  /** Who only may be offered this guest by Call next (Q-18); null when open to everyone. */
  assignedStaffId: string | null;
  assignedCounterId: string | null;
  /** The priority class the visit was given (Q-10); null for none. */
  priorityClassId: string | null;
  /** When a guest who joined for later enters the line (ISO), else null (J-13). */
  arriveAfter: string | null;
  /** Staff-only free text and chips (S-8); '' and [] when none. */
  notes: string;
  tags: string[];
  /** The row's version, sent back with an action so a stale tap fails as `stale_visit`. */
  version: number;
  /** What staff may do to this visit now, from the database (rule 2: never re-derived here). */
  actions: VisitAction[];
}

/** What the notes and tags sheet needs of a visit. */
export type NotesTarget = Pick<ConsoleVisit, 'id' | 'ticket' | 'notes' | 'tags' | 'version'>;

export type VisitAction = Database['api']['Enums']['visit_action'];
/** What every staff visit function returns, including `last_event_id` for undo. */
export type VisitRow = Database['api']['CompositeTypes']['visit_row'];

/**
 * Every active visit at the location, in queue order (`sort_key`, owned by the database), read
 * from `app.staff_visits` (which also carries each row's `allowed_actions`) under RLS and kept live by the private `loc:` signal: one query for all tabs, so switching
 * tabs is instant and every tab can show its count. Contact details are never selected.
 */
export function useConsoleVisits(locationId: string | undefined) {
  return useLiveQuery({
    topic: locationId ? `loc:${locationId}` : null,
    queryKey: ['console', 'visits', locationId],
    queryFn: async (): Promise<ConsoleVisit[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('staff_visits')
        .select(
          'id, queue_id, display_ticket, status, source, scheduled_at, arrival_early_until, arrival_late_after, guest_name, guest_id, party_size, group_key, on_the_way, journey_next_queue_id, assigned_staff_id, assigned_counter_id, priority_class_id, arrive_after, notes, tags, joined_at, called_at, serving_at, finished_at, version, allowed_actions, services(name, expected_minutes), counters!visits_org_id_location_id_counter_id_fkey(label)',
        )
        .eq('location_id', locationId!)
        .or(
          `status.in.(waiting,called,serving,expected),and(status.eq.no_show,finished_at.gte.${new Date(
            Date.now() - NO_SHOW_WINDOW_MS,
          ).toISOString()})`,
        )
        .order('sort_key');
      if (error) throw error;
      return data.map((v) => ({
        id: v.id,
        queueId: v.queue_id,
        ticket: v.display_ticket,
        status: v.status as ActiveState,
        name: v.guest_name,
        partySize: v.party_size,
        groupKey: v.group_key,
        onTheWay: v.on_the_way ?? false,
        journeyNextQueueId: v.journey_next_queue_id ?? null,
        guestId: v.guest_id,
        service: v.services?.name ?? null,
        expectedMinutes: v.services?.expected_minutes ?? null,
        counter: v.counters?.label ?? null,
        source: v.source,
        scheduledAt: v.scheduled_at,
        earlyUntil: v.arrival_early_until,
        lateAfter: v.arrival_late_after,
        joinedAt: v.joined_at,
        since:
          (v.status === 'serving'
            ? v.serving_at
            : v.status === 'called'
              ? v.called_at
              : v.status === 'no_show'
                ? v.finished_at
                : v.status === 'expected'
                  ? (v.scheduled_at ?? v.arrive_after)
                  : null) ?? v.joined_at,
        assignedStaffId: v.assigned_staff_id,
        assignedCounterId: v.assigned_counter_id,
        priorityClassId: v.priority_class_id,
        arriveAfter: v.arrive_after,
        notes: v.notes ?? '',
        tags: v.tags ?? [],
        version: v.version,
        actions: v.allowed_actions ?? [],
      }));
    },
    // A signal carries a queue version, but the list spans queues and a refetch is one small read.
    jitterMs: 0,
    enabled: !!locationId,
  });
}

/** Refetches the console list now rather than waiting for the location signal. */
function useRefreshVisits() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['console', 'visits'] });
}

/** The permission a custom role must list for a staff action (4-RBAC1). Other actions need none. */
const ACTION_PERMISSION: Partial<Record<VisitAction, string>> = {
  call: 'visits.call',
  recall: 'visits.call',
  remove: 'visits.remove',
  cancel: 'visits.remove',
};

/** `actions` minus those the caller's permissions rule out. The guards in the database still decide. */
export function permittedActions(
  actions: VisitAction[],
  permissions: readonly string[] | undefined,
) {
  if (!permissions) return actions;
  return actions.filter((a) => {
    const needed = ACTION_PERMISSION[a];
    return !needed || permissions.includes(needed);
  });
}

/** `api.my_permissions`: what the signed-in member may do at the location, for hiding what they can't. */
export function useMyPermissions(orgId: string | undefined, locationId: string | undefined) {
  return useQuery({
    queryKey: ['console', 'permissions', orgId, locationId],
    enabled: !!orgId && !!locationId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_permissions', {
        p_org_id: orgId!,
        p_location_id: locationId!,
      });
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Calls the first waiting guest of a queue to `counterId` (S-2). Each tap gets its own
 * idempotency key, so two tablets tapping together call two different guests. Resolves to the
 * called visit's row (with `last_event_id` for undo), or null when nobody was waiting.
 */
export function useCallNext() {
  const refresh = useRefreshVisits();
  return useMutation({
    mutationFn: async ({ queueId, counterId }: { queueId: string; counterId: string | null }) => {
      const { data, error } = await supabase.rpc('call_next', {
        p_queue_id: queueId,
        // The generated type says string, but the function takes null for "no counter".
        p_counter_id: counterId as string,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data?.id ? data : null;
    },
    onSettled: refresh,
  });
}

/**
 * Applies one of a visit's `actions` (`transition_visit`). A visit that changed since this
 * tablet read it fails with `stale_visit`; the list refetches either way.
 */
/** While offline the action is stored and the result is a `QueuedRow` (see `isQueued`). */
export function useVisitAction() {
  const refresh = useRefreshVisits();
  return useMutation({
    // Offline the mutation must still run: it stores the action instead of waiting for a network.
    networkMode: 'always',
    mutationFn: async ({
      visit,
      action,
      counterId,
      reason,
    }: {
      visit: ConsoleVisit;
      action: VisitAction;
      counterId?: string | null;
      /** Required for `remove`; recorded on the visit's event. */
      reason?: string;
    }) => {
      return callOrQueue<VisitRow>(
        'transition_visit',
        {
          p_visit_id: visit.id,
          p_action: action,
          p_expected_version: visit.version,
          p_idempotency_key: crypto.randomUUID(),
          ...(counterId ? { p_counter_id: counterId } : {}),
          ...(reason ? { p_reason: reason } : {}),
        },
        visit.id,
        { action, ticket: visit.ticket, name: visit.name },
      );
    },
    onSettled: refresh,
  });
}

export interface NewGuest {
  queueId: string;
  serviceId: string | null;
  name: string;
  partySize: number;
  phoneE164: string | null;
}

/**
 * Adds a walk-in on the guest's behalf (`staff_add_visit`), under the same rules as an online
 * join, so a closed or paused queue refuses with `queue_not_accepting`. Call `mutate` once per
 * submit: the key is made per call, and a retry of the same submit should reuse its key.
 */
export function useAddGuest() {
  const refresh = useRefreshVisits();
  return useMutation({
    // Offline the mutation must still run: it stores the action instead of waiting for a network.
    networkMode: 'always',
    mutationFn: async ({ guest, key }: { guest: NewGuest; key: string }) => {
      return callOrQueue<VisitRow>(
        'staff_add_visit',
        {
          p_queue_id: guest.queueId,
          // Generated types say string; the function takes null for "no service" / "no phone".
          p_service_id: guest.serviceId,
          p_name: guest.name,
          p_party_size: guest.partySize,
          p_phone_e164: guest.phoneE164,
          p_idempotency_key: key,
        },
        null,
        { action: 'add', ticket: null, name: guest.name || null },
      );
    },
    onSettled: refresh,
  });
}

/** The version of the attestation wording staff tick (`console.addGuest.attest.v1`). */
export const ATTESTATION_TEXT_VERSION = 1;

/**
 * The channels the business has switched on (`location_channels`). The add-guest form offers the
 * text opt-in only when `sms` is among them; until it answers, nothing is offered.
 */
export function useLocationChannels(locationId: string | undefined): string[] {
  const query = useQuery({
    queryKey: ['console', 'channels', locationId],
    enabled: !!locationId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('location_channels', {
        p_location_id: locationId!,
      });
      if (error) throw error;
      return data as string[];
    },
  });
  return query.data ?? [];
}

/**
 * Records that the guest agreed to texts about this visit (`staff_capture_consent`, 3-CG3).
 * Call it after `staff_add_visit` succeeds; failures (`contact_suppressed`, anything else) leave
 * the visit in place and texts off.
 */
export function useCaptureConsent() {
  return useMutation({
    mutationFn: async ({ visitId, key }: { visitId: string; key: string }) => {
      const { data, error } = await supabase.rpc('staff_capture_consent', {
        p_visit_id: visitId,
        p_channel: 'sms',
        p_attested: true,
        p_text_version: ATTESTATION_TEXT_VERSION,
        p_idempotency_key: key,
      });
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Reverses a staff action by its event (`undo_event`, S-6). Fails with `undo_not_allowed` once
 * anything else changed the visit or ten minutes have passed; the database decides.
 */
export function useUndo() {
  const refresh = useRefreshVisits();
  return useMutation({
    mutationFn: async (eventId: number) => {
      const { data, error } = await supabase.rpc('undo_event', {
        p_event_id: eventId,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSettled: refresh,
  });
}

/**
 * Puts a waiting visit just after another (`move_visit`; null = first). Drag and the move buttons
 * both end here. The row answers with `last_event_id` for undo; a visit that changed since this
 * tablet read it fails with `stale_visit`. The list refetches either way.
 */
export function useMoveVisit() {
  const refresh = useRefreshVisits();
  return useMutation({
    mutationFn: async ({ visit, afterId }: { visit: ConsoleVisit; afterId: string | null }) => {
      const { data, error } = await supabase.rpc('move_visit', {
        p_visit_id: visit.id,
        // The generated type says string; null means "to the front".
        p_after_visit_id: afterId as string,
        p_expected_version: visit.version,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSettled: refresh,
  });
}

/**
 * Resolves a scanned or typed scan code to a visit id (`find_visit_by_scan_code`). Rejects with
 * Error('not_found') alike for an unknown code, an earlier day and another location.
 */
export function useFindByScanCode(locationId: string) {
  return useMutation({
    mutationFn: async (code: string) => {
      const { data, error } = await supabase.rpc('find_visit_by_scan_code', {
        p_location_id: locationId,
        p_code: code,
      });
      if (error) throw new Error(errorCode(error));
      return data.id as string;
    },
  });
}

/** The most ids `api.guest_badges` accepts in one call. */
const BADGE_CHUNK = 200;

export interface GuestBadge {
  visitCount: number;
  lastVisitAt: string | null;
}

/**
 * `api.guest_badges` for the visits on screen (2P-CRM4, #187). Keyed on the set of ids, so a new
 * arrival refetches and a status change does not. The RPC takes at most 200 ids, so a long line is
 * asked for in chunks: a cap by id would drop the badge of whichever guests sort last. Only repeat
 * guests are returned, by visit id. A failure just means no badges: the list works without them.
 */
export function useGuestBadges(visitIds: string[]) {
  const ids = [...new Set(visitIds)].sort();
  return useQuery({
    queryKey: ['console', 'badges', ids],
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<Map<string, GuestBadge>> => {
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += BADGE_CHUNK) chunks.push(ids.slice(i, i + BADGE_CHUNK));
      const pages = await Promise.all(
        chunks.map(async (chunk) => {
          const { data, error } = await supabase.rpc('guest_badges', { p_visit_ids: chunk });
          if (error) throw new Error(errorCode(error));
          return data;
        }),
      );
      return new Map(
        pages
          .flat()
          .filter((b) => b.is_repeat)
          .map((b) => [
            b.visit_id!,
            { visitCount: b.visit_count ?? 0, lastVisitAt: b.last_visit_at },
          ]),
      );
    },
  });
}

/**
 * Saves a visit's notes and tags (`update_visit_notes`). Both are sent whole, so the form is what
 * is stored. A visit that changed since this tablet read it fails with `stale_visit`.
 */
export function useUpdateNotes() {
  const refresh = useRefreshVisits();
  return useMutation({
    mutationFn: async ({
      visit,
      notes,
      tags,
    }: {
      visit: NotesTarget;
      notes: string;
      tags: string[];
    }) => {
      const { data, error } = await supabase.rpc('update_visit_notes', {
        p_visit_id: visit.id,
        p_notes: notes,
        p_tags: tags,
        p_expected_version: visit.version,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSettled: refresh,
  });
}

/** How long a block lasts, in days; `null` is forever. */
export type BlockDuration = 1 | 30 | null;

/**
 * `api.block_from_visit`: blocks the visit's phone, email and device for the whole business
 * (managers and above). Errors: `invalid_input` when the visit carries nothing to block,
 * `not_found`. The caller removes the visit separately, with the same reason (2P-PRV6, #193).
 */
export function useBlockVisit() {
  return useMutation({
    mutationFn: async ({
      visit,
      reason,
      days,
    }: {
      visit: ConsoleVisit;
      reason: string;
      days: BlockDuration;
    }) => {
      const { data, error } = await supabase.rpc('block_from_visit', {
        p_visit_id: visit.id,
        p_reason: reason.trim(),
        // The generated type says string; the function reads null as "forever".
        p_expires_at: (days === null
          ? null
          : new Date(Date.now() + days * 86_400_000).toISOString()) as string,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });
}

/** One line of a visit's history (`visit_history`), oldest first. */
export interface VisitHistoryEntry {
  at: string;
  type: string;
  actor: string | null;
  from: string | null;
  to: string | null;
  reason: string | null;
  /** Event details without personal data; `undone: true` marks a reversed action. */
  summary: Record<string, unknown>;
}

/** Everything that happened to one visit, including finished ones and notification outcomes. */
export function useVisitHistory(visitId: string) {
  return useQuery({
    queryKey: ['console', 'history', visitId],
    // A history is read to settle a question about now: never serve a copy from before the last action.
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async (): Promise<VisitHistoryEntry[]> => {
      const { data, error } = await supabase.rpc('visit_history', { p_visit_id: visitId });
      if (error) throw error;
      return data.map((h) => ({
        at: h.occurred_at ?? '',
        type: h.type ?? '',
        actor: h.actor_label,
        from: h.from_status,
        to: h.to_status,
        reason: h.reason,
        summary: (h.summary ?? {}) as Record<string, unknown>,
      }));
    },
  });
}

/** A finished visit shown under "Done today". */
export interface DoneVisit {
  id: string;
  ticket: string;
  status: string;
  name: string | null;
  version: number;
  joinedAt: string;
  calledAt: string | null;
  servingAt: string | null;
  finishedAt: string;
}

export const DONE_WINDOW_MS = 12 * 60 * 60_000;

/**
 * Visits that finished in the last 12 hours, newest first, for the history drawer (S-16). A
 * rolling window rather than "since midnight": the service day is the database's to compute
 * (I-6) and no endpoint hands it out.
 */
export function useDoneVisits(locationId: string | undefined) {
  return useLiveQuery({
    topic: locationId ? `loc:${locationId}` : null,
    queryKey: ['console', 'done', locationId],
    queryFn: async (): Promise<DoneVisit[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('staff_visits')
        .select(
          'id, display_ticket, status, guest_name, version, joined_at, called_at, serving_at, finished_at',
        )
        .eq('location_id', locationId!)
        .in('status', ['served', 'no_show', 'cancelled', 'removed', 'expired'])
        .gte('finished_at', new Date(Date.now() - DONE_WINDOW_MS).toISOString())
        .order('finished_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      // A no-show stays in its own section for two hours; after that it is only reachable here.
      const noShowCutoff = Date.now() - NO_SHOW_WINDOW_MS;
      return data
        .filter((v) => v.status !== 'no_show' || Date.parse(v.finished_at ?? '') < noShowCutoff)
        .map((v) => ({
          id: v.id,
          ticket: v.display_ticket,
          status: v.status,
          name: v.guest_name,
          version: v.version,
          joinedAt: v.joined_at,
          calledAt: v.called_at,
          servingAt: v.serving_at,
          finishedAt: v.finished_at ?? '',
        }));
    },
    jitterMs: 0,
    enabled: !!locationId,
  });
}

/**
 * Corrects the called, serving and finished times of a finished visit (`correct_visit_times`,
 * S-18). A time left null stays as it is; a reason is required. The database checks order and
 * who may correct (`invalid_times`, `permission_denied`).
 */
export function useCorrectTimes() {
  const queryClient = useQueryClient();
  const refresh = useRefreshVisits();
  return useMutation({
    mutationFn: async ({
      visit,
      calledAt,
      servingAt,
      finishedAt,
      reason,
    }: {
      visit: DoneVisit;
      calledAt: string | null;
      servingAt: string | null;
      finishedAt: string | null;
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc('correct_visit_times', {
        p_visit_id: visit.id,
        // The generated types say string; null leaves that time as it is.
        p_called_at: calledAt as string,
        p_serving_at: servingAt as string,
        p_finished_at: finishedAt as string,
        p_reason: reason,
        p_expected_version: visit.version,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSettled: async (_data, _error, { visit }) => {
      await queryClient.invalidateQueries({ queryKey: ['console', 'history', visit.id] });
      await queryClient.invalidateQueries({ queryKey: ['console', 'done'] });
      refresh();
    },
  });
}

/** One hit of a visit search: enough to recognise the guest and open the visit. */
export interface SearchHit {
  id: string;
  ticket: string;
  status: string;
  name: string | null;
  service: string | null;
  joinedAt: string;
}

/**
 * Visits of the location from today and yesterday whose name, ticket or phone ending matches
 * `query` (`search_visits`, S-9). Off below two characters; the database rate-limits and never
 * returns contact details. Callers debounce `query`.
 */
export function useSearchVisits(locationId: string | undefined, query: string) {
  return useQuery({
    queryKey: ['console', 'search', locationId, query],
    enabled: !!locationId && query.length >= 2,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<SearchHit[]> => {
      const { data, error } = await supabase.rpc('search_visits', {
        p_location_id: locationId!,
        p_query: query,
        p_days: 2,
        p_limit: 20,
      });
      if (error) throw error;
      return data.map((v) => ({
        id: v.id ?? '',
        ticket: v.display_ticket ?? '',
        status: v.status ?? '',
        name: v.guest_name,
        service: v.service_name,
        joinedAt: v.joined_at ?? '',
      }));
    },
  });
}

/** A visit's notes, tags and version for the details sheet, read when a search hit is opened. */
export function useVisitForDetail(visitId: string | null) {
  return useQuery({
    queryKey: ['console', 'detail', visitId],
    enabled: !!visitId,
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async (): Promise<NotesTarget> => {
      const { data, error } = await supabase
        .schema('app')
        .from('staff_visits')
        .select('id, display_ticket, notes, tags, version')
        .eq('id', visitId!)
        .single();
      if (error) throw error;
      return {
        id: data.id,
        ticket: data.display_ticket,
        notes: data.notes ?? '',
        tags: data.tags ?? [],
        version: data.version,
      };
    },
  });
}

/**
 * Moves a waiting visit to another queue or service (`transfer_visit`, S-5). The row answers
 * with `last_event_id` for undo. A null service keeps it within one queue and leaves it unset
 * across queues. Fails with `queue_not_accepting` or `stale_visit`.
 */
export function useTransferVisit() {
  const refresh = useRefreshVisits();
  return useMutation({
    mutationFn: async ({
      visit,
      toQueueId,
      toServiceId,
    }: {
      visit: ConsoleVisit;
      toQueueId: string;
      toServiceId: string | null;
    }) => {
      const { data, error } = await supabase.rpc('transfer_visit', {
        p_visit_id: visit.id,
        p_to_queue_id: toQueueId,
        // The generated type says string; null means "keep" or "none".
        p_to_service_id: toServiceId as string,
        p_expected_version: visit.version,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSettled: refresh,
  });
}

/**
 * Assigns a waiting visit to a counter, a person or both; both null unassigns (`assign_visit`,
 * Q-18). Call next then offers the guest only to that counter or person. The database checks that
 * the counter and the person belong to the location.
 */
export function useAssignVisit() {
  const refresh = useRefreshVisits();
  return useMutation({
    mutationFn: async ({
      visit,
      counterId,
      staffUserId,
    }: {
      visit: ConsoleVisit;
      counterId: string | null;
      staffUserId: string | null;
    }) => {
      const { data, error } = await supabase.rpc('assign_visit', {
        p_visit_id: visit.id,
        // The generated types say string; null leaves that side unassigned.
        p_counter_id: counterId as string,
        p_staff_user_id: staffUserId as string,
        p_expected_version: visit.version,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSettled: refresh,
  });
}

/**
 * Sets a temporary "current wait" for a queue, or clears it with null minutes
 * (`set_wait_override`, W-5). The database cuts `until` at the end of the service day, so
 * "rest of the day" is just a far-off time.
 */
export function useSetWaitOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      queueId,
      minutes,
      until,
    }: {
      queueId: string;
      minutes: number | null;
      until: string | null;
    }) => {
      const { error } = await supabase.rpc('set_wait_override', {
        p_queue_id: queueId,
        // The generated types say number/string; null clears the override and defaults the expiry.
        p_minutes: minutes as number,
        p_until: until as string,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['console', 'queues'] }),
  });
}

/** The names of a visit's companions (J-14), oldest first, read under RLS for the detail sheet. */
export function useCompanions(visitId: string) {
  return useQuery({
    queryKey: ['console', 'companions', visitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('visit_companions')
        .select('first_name')
        .eq('visit_id', visitId)
        .order('created_at')
        .order('id');
      if (error) throw error;
      return data.map((c) => c.first_name);
    },
  });
}

/**
 * Replaces a visit's companions (`staff_set_companions`); the database re-sizes the party. Errors:
 * `party_limit`, `stale_visit`, `illegal_transition` for a finished visit.
 */
export function useSetCompanions() {
  const refresh = useRefreshVisits();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      visit,
      names,
    }: {
      visit: { id: string; version: number };
      names: string[];
    }) => {
      const { data, error } = await supabase.rpc('staff_set_companions', {
        p_visit_id: visit.id,
        p_names: names,
        p_expected_version: visit.version,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSettled: (_data, _error, { visit }) => {
      void queryClient.invalidateQueries({ queryKey: ['console', 'companions', visit.id] });
      return refresh();
    },
  });
}

/**
 * Sends a serving visit to the next step of its journey (`advance_journey`). Answers with
 * `last_event_id` for undo; the list refetches either way.
 */
export function useAdvanceJourney() {
  const refresh = useRefreshVisits();
  return useMutation({
    mutationFn: async ({ visit }: { visit: ConsoleVisit }) => {
      const { data, error } = await supabase.rpc('advance_journey', {
        p_visit_id: visit.id,
        p_expected_version: visit.version,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSettled: refresh,
  });
}

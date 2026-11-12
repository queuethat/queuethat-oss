import { classifyCommand, classifyKeyword, errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** The settings an admin edits on a queue (A5, #45). Open, paused and closed stay on the console. */
export interface QueueSettings {
  name: string;
  /** One to three capital letters; tickets read B001, B002, … */
  ticketPrefix: string;
  /** Most guests waiting at once; null is unlimited. */
  capacity: number | null;
  serversOnDuty: number;
  showEta: boolean;
  joinRatePerMin: number;
  /** Online joins the queue takes in any hour, 1 to 1000; above it guests are sent to the desk. */
  onlineJoinsPerHour: number;
  /** Guests say how many people they are; the join page shows a stepper between min and max. */
  partySizeEnabled: boolean;
  partySizeMin: number;
  partySizeMax: number;
  /** Called guests who don't show are marked no-show after the grace period (they're warned first). */
  autoNoShowEnabled: boolean;
  graceMinutes: number;
  /** Seconds before the grace period ends when the guest gets a last warning; at least 20. */
  noShowWarningSeconds: number;
  /** Minutes into service before staff are reminded; null lets the system decide. */
  servingReminderMinutes: number | null;
  /** The guest alerts this queue offers (N-8); a guest can only switch off ones listed here. */
  notifyTriggers: AlertTrigger[];
  /** The "almost up" alert goes to guests within this many places of the front, 1 to 20. */
  almostUpThreshold: number;
  /** Whether arriving guests are given a counter (2B-Q5); staff can still call anyone. */
  assignmentStrategy: AssignmentStrategy;
  /** Extra proof a public join must carry (2B-Q10): the on-site code, or a position near the location. */
  joinRestriction: JoinRestriction;
  /** Guests may reserve a place for later today (J-13), up to this many hours ahead. */
  joinLaterEnabled: boolean;
  joinLaterMaxHours: number;
  /** Texting this word to the venue's number joins the queue (J-8); null turns text-to-join off. */
  smsKeyword: string | null;
}

export const JOIN_RESTRICTIONS = ['none', 'onsite_code', 'geofence'] as const;
export type JoinRestriction = (typeof JOIN_RESTRICTIONS)[number];

export const ASSIGNMENT_STRATEGIES = ['none', 'round_robin', 'least_busy'] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];

/** Every alert a queue can offer, in the order owners see them. The database checks the same set. */
export const ALERT_TRIGGERS = [
  'joined',
  'called',
  'almost_up',
  'position_changed',
  'eta_changed',
  'no_show_warning',
  'removed',
  'served',
] as const;
export type AlertTrigger = (typeof ALERT_TRIGGERS)[number];

export interface QueueRow extends QueueSettings {
  id: string;
  /** The catalog template and version this queue was copied from (T1), or null when hand-made. */
  origin: { template: string; version: number } | null;
}

export const NEW_QUEUE: QueueSettings = {
  name: '',
  ticketPrefix: 'A',
  capacity: null,
  serversOnDuty: 1,
  showEta: true,
  joinRatePerMin: 60,
  onlineJoinsPerHour: 120,
  partySizeEnabled: false,
  partySizeMin: 1,
  partySizeMax: 10,
  autoNoShowEnabled: false,
  graceMinutes: 5,
  noShowWarningSeconds: 60,
  servingReminderMinutes: null,
  notifyTriggers: ['called', 'almost_up', 'position_changed', 'eta_changed'],
  almostUpThreshold: 2,
  assignmentStrategy: 'none',
  joinRestriction: 'none',
  joinLaterEnabled: false,
  joinLaterMaxHours: 4,
  smsKeyword: null,
};

const queuesKey = (locationId: string) => ['admin', 'queues', locationId];

/** A location's queues that are not archived, read under RLS. */
export const queuesQuery = (locationId: string) =>
  queryOptions({
    queryKey: queuesKey(locationId),
    queryFn: async (): Promise<QueueRow[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('queues')
        .select(
          'id, name, ticket_prefix, capacity, servers_on_duty, show_eta, join_rate_per_min, online_joins_per_hour, party_size_enabled, party_size_min, party_size_max, auto_no_show_enabled, grace_minutes, no_show_warning_seconds, serving_reminder_minutes, notify_triggers, almost_up_threshold, assignment_strategy, join_later_enabled, join_later_max_hours, join_restriction, sms_keyword, origin_template, origin_version',
        )
        .eq('location_id', locationId)
        .is('archived_at', null)
        .order('sort_order')
        .order('name');
      if (error) throw error;
      return data.map((q) => ({
        id: q.id,
        name: q.name,
        ticketPrefix: q.ticket_prefix,
        capacity: q.capacity,
        serversOnDuty: q.servers_on_duty,
        showEta: q.show_eta,
        joinRatePerMin: q.join_rate_per_min,
        onlineJoinsPerHour: q.online_joins_per_hour,
        partySizeEnabled: q.party_size_enabled,
        partySizeMin: q.party_size_min,
        partySizeMax: q.party_size_max,
        autoNoShowEnabled: q.auto_no_show_enabled,
        graceMinutes: q.grace_minutes,
        noShowWarningSeconds: q.no_show_warning_seconds,
        servingReminderMinutes: q.serving_reminder_minutes,
        notifyTriggers: q.notify_triggers as AlertTrigger[],
        almostUpThreshold: q.almost_up_threshold,
        assignmentStrategy: q.assignment_strategy,
        joinRestriction: q.join_restriction,
        joinLaterEnabled: q.join_later_enabled,
        joinLaterMaxHours: q.join_later_max_hours,
        smsKeyword: q.sms_keyword,
        origin:
          q.origin_template && q.origin_version
            ? { template: q.origin_template, version: q.origin_version }
            : null,
      }));
    },
  });

const columns = (q: QueueSettings) => ({
  name: q.name.trim(),
  ticket_prefix: q.ticketPrefix,
  capacity: q.capacity,
  servers_on_duty: q.serversOnDuty,
  show_eta: q.showEta,
  join_rate_per_min: q.joinRatePerMin,
  online_joins_per_hour: q.onlineJoinsPerHour,
  party_size_enabled: q.partySizeEnabled,
  party_size_min: q.partySizeMin,
  party_size_max: q.partySizeMax,
  auto_no_show_enabled: q.autoNoShowEnabled,
  grace_minutes: q.graceMinutes,
  no_show_warning_seconds: q.noShowWarningSeconds,
  serving_reminder_minutes: q.servingReminderMinutes,
  notify_triggers: q.notifyTriggers,
  almost_up_threshold: q.almostUpThreshold,
  assignment_strategy: q.assignmentStrategy,
  join_restriction: q.joinRestriction,
  join_later_enabled: q.joinLaterEnabled,
  sms_keyword: q.smsKeyword?.trim() || null,
  join_later_max_hours: q.joinLaterMaxHours,
});

/**
 * The first policy problem with these settings, or null. The database checks the same bounds
 * (check constraints); this only tells the admin before they save.
 */
export function policyProblem(
  q: QueueSettings,
): 'partyRange' | 'warning' | 'warningVsGrace' | 'reminder' | 'threshold' | 'joinLater' | null {
  if (
    q.partySizeEnabled &&
    !(q.partySizeMin >= 1 && q.partySizeMin <= q.partySizeMax && q.partySizeMax <= 50)
  )
    return 'partyRange';
  if (q.noShowWarningSeconds < 20) return 'warning';
  if (q.noShowWarningSeconds >= q.graceMinutes * 60) return 'warningVsGrace';
  if (q.servingReminderMinutes !== null && q.servingReminderMinutes < 15) return 'reminder';
  if (!(q.almostUpThreshold >= 1 && q.almostUpThreshold <= 20)) return 'threshold';
  if (q.joinLaterEnabled && !(q.joinLaterMaxHours >= 1 && q.joinLaterMaxHours <= 12))
    return 'joinLater';
  return null;
}

type Change =
  | { kind: 'create'; settings: QueueSettings }
  | { kind: 'update'; id: string; settings: QueueSettings }
  | { kind: 'archive'; id: string };

/**
 * Creates, edits or archives a queue under RLS (managers and up, `queues_*` policies); the audit
 * trigger records each change. Archiving hides the queue and stops joins; nothing is deleted.
 * A row RLS hides fails as `permission_denied`.
 */
export function useChangeQueue(org: { orgId: string; locationId: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: Change) => {
      const queues = supabase.schema('app').from('queues');
      const { data, error } =
        change.kind === 'create'
          ? await queues
              .insert({
                org_id: org.orgId,
                location_id: org.locationId,
                ...columns(change.settings),
              })
              .select('id')
          : await queues
              .update(
                change.kind === 'update'
                  ? columns(change.settings)
                  : { archived_at: new Date().toISOString() },
              )
              .eq('id', change.id)
              .select('id');
      // 23505 is the per-org unique index, 23514 the reserved-word check.
      if (error)
        throw new Error(
          error.code === '23505'
            ? 'keyword_taken'
            : error.code === '23514'
              ? 'keyword_invalid'
              : errorCode(error),
        );
      if (data.length === 0) throw new Error('permission_denied');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queuesKey(org.locationId) }),
  });
}

/** Roles that may manage queues; the database enforces the same ladder. */
export const canManageQueues = (role: string | undefined) =>
  role === 'manager' || role === 'admin' || role === 'owner';

/**
 * Tells the admin before they save what the database would refuse for a text-to-join keyword
 * (checks and a unique index own the rule; the word lists come from @qm/domain).
 */
export function smsKeywordProblem(
  keyword: string | null,
  takenByOthers: readonly (string | null)[],
): 'format' | 'reserved' | 'duplicate' | null {
  const word = keyword?.trim();
  if (!word) return null;
  if (!/^[A-Za-z0-9]{2,20}$/.test(word)) return 'format';
  if (word.toUpperCase() === 'JOIN' || classifyKeyword(word) || classifyCommand(word))
    return 'reserved';
  if (takenByOthers.some((k) => k?.toUpperCase() === word.toUpperCase())) return 'duplicate';
  return null;
}

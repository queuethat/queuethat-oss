import type { Database } from '@qm/db-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

type Row = Database['api']['CompositeTypes']['notification_status'];
/** `channel` is renamed `via`: the lint rule reserves the `.channel` property for Realtime. */
export type NotificationStatus = Omit<Row, 'channel'> & { via: string | null };

// db-types resolves `setof api.notification_status` to the same-named app enum (generator name clash), so rows are typed here.
const rows = (data: unknown): NotificationStatus[] =>
  // eslint-disable-next-line no-restricted-properties -- a DB column, not a Realtime channel
  ((data ?? []) as Row[]).map((r) => ({ ...r, via: r.channel }));

/** How often a delivery view looks again: a failed `called` message must show within seconds. */
export const DELIVERY_POLL_MS = 3_000;

/**
 * One visit's message history, oldest first (`list_visit_notifications`, N-12). Never carries the
 * address or the text. Errors: `not_found`.
 */
export function useVisitNotifications(visitId: string, enabled = true) {
  return useQuery({
    queryKey: ['messages', 'visit', visitId],
    enabled,
    refetchInterval: DELIVERY_POLL_MS,
    queryFn: async (): Promise<NotificationStatus[]> => {
      const { data, error } = await supabase.rpc('list_visit_notifications', {
        p_visit_id: visitId,
      });
      if (error) throw error;
      return rows(data);
    },
  });
}

/** The last 24 hours, rounded to the minute so every caller shares one cache entry. */
const since = () => new Date(Math.floor((Date.now() - 86_400_000) / 60_000) * 60_000).toISOString();

/** Dead, failed and suppressed messages of the location (`list_failed_notifications`). */
export function useFailedNotifications(locationId: string | undefined) {
  return useQuery({
    queryKey: ['messages', 'failed', locationId],
    enabled: !!locationId,
    refetchInterval: DELIVERY_POLL_MS,
    queryFn: async (): Promise<NotificationStatus[]> => {
      const { data, error } = await supabase.rpc('list_failed_notifications', {
        p_location_id: locationId!,
        p_since: since(),
      });
      if (error) throw error;
      return rows(data);
    },
  });
}

/** Visits whose `called` message is dead or suppressed: the console row shows a warning. */
export function useDeliveryWarnings(locationId: string | undefined): Set<string> {
  const failed = useFailedNotifications(locationId);
  return new Set(
    (failed.data ?? [])
      .filter((n) => n.template === 'called' && (n.status === 'dead' || n.status === 'suppressed'))
      .map((n) => n.visit_id)
      .filter((id): id is string => !!id),
  );
}

export type TextState = 'none' | 'on' | 'no_consent' | 'opted_out';

/**
 * Whether each live guest of the location can receive texts (`visit_text_states`, 3-CG10). The
 * database owns the rule; an opt-out shows within one poll of the STOP arriving.
 */
export function useTextStates(locationId: string | undefined): Map<string, TextState> {
  const query = useQuery({
    queryKey: ['messages', 'text-states', locationId],
    enabled: !!locationId,
    refetchInterval: DELIVERY_POLL_MS,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('visit_text_states', {
        p_location_id: locationId!,
      });
      if (error) throw error;
      return data as unknown as { visit_id: string; text_state: TextState }[];
    },
  });
  return new Map((query.data ?? []).map((r) => [r.visit_id, r.text_state]));
}

/** `retry_notification` (managers): a dead message goes back to the dispatcher. Errors: `not_relevant`, `not_found`. */
export function useRetryNotification() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (notificationId: string): Promise<NotificationStatus> => {
      const { data, error } = await supabase.rpc('retry_notification', {
        p_notification_id: notificationId,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return rows([data])[0]!;
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['messages'] }),
  });
}

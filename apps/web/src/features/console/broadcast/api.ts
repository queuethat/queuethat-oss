import type { Database } from '@qm/db-types';
import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export type BroadcastResult = Database['api']['CompositeTypes']['broadcast_result'];

export interface BroadcastRecord {
  id: string;
  body: string;
  recipients: number;
  suppressed: number;
  createdAt: string;
}

const historyKey = (queueId: string) => ['console', 'broadcasts', queueId] as const;
const DAY_MS = 24 * 60 * 60_000;

/** Messages sent to this queue in the last 24 hours, newest first. Managers and above (RLS). */
export const broadcastsQuery = (queueId: string, enabled: boolean) =>
  queryOptions({
    queryKey: historyKey(queueId),
    enabled,
    queryFn: async (): Promise<BroadcastRecord[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('queue_broadcasts')
        .select('id, body, recipients, suppressed, created_at')
        .eq('queue_id', queueId)
        .gte('created_at', new Date(Date.now() - DAY_MS).toISOString())
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw new Error(errorCode(error));
      return data.map((r) => ({
        id: r.id,
        body: r.body,
        recipients: r.recipients,
        suppressed: r.suppressed,
        createdAt: r.created_at,
      }));
    },
  });

export function useBroadcasts(queueId: string, enabled: boolean) {
  return useQuery(broadcastsQuery(queueId, enabled));
}

/**
 * `api.send_queue_message`: texts every waiting or called guest of the queue. `idempotencyKey`
 * makes a retry after a lost answer a replay, not a second message. Rejects with
 * Error(<error code>): `rate_limited`, `unknown_variable`, `invalid_input`, `org_suspended`,
 * `permission_denied`.
 */
export function useSendQueueMessage(queueId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, idempotencyKey }: { body: string; idempotencyKey: string }) => {
      const { data, error } = await supabase.rpc('send_queue_message', {
        p_queue_id: queueId,
        p_body: body,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw new Error(errorCode(error));
      return data as BroadcastResult;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: historyKey(queueId) }),
  });
}

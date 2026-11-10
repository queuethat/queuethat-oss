import { errorCode } from '@qm/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from '../../../lib/live.ts';
import { supabase } from '../../../lib/supabase.ts';

export interface ChatLine {
  id: number;
  sender: 'guest' | 'staff';
  body: string;
  createdAt: string;
}

/**
 * Unread guest messages per visit at the location (G-15), live on the private `loc:` signal: every
 * message bumps its queue's version, which the location signal announces. Bodies are not read here.
 */
export function useUnreadChat(locationId: string | undefined) {
  return useLiveQuery({
    topic: locationId ? `loc:${locationId}` : null,
    queryKey: ['console', 'chat-unread', locationId],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase
        .schema('app')
        .from('visit_messages')
        .select('visit_id')
        .eq('location_id', locationId!)
        .eq('sender', 'guest')
        .is('read_at', null);
      if (error) throw error;
      const counts: Record<string, number> = {};
      for (const row of data) counts[row.visit_id] = (counts[row.visit_id] ?? 0) + 1;
      return counts;
    },
    jitterMs: 0,
    enabled: !!locationId,
  });
}

/** One visit's messages, oldest first. `unread` re-runs the read when the unread count moves. */
export function useChatMessages(visitId: string, unread: number) {
  return useQuery({
    queryKey: ['console', 'chat', visitId, unread],
    queryFn: async (): Promise<ChatLine[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('visit_messages')
        .select('id, sender, body, created_at')
        .eq('visit_id', visitId)
        .order('id');
      if (error) throw error;
      return data.map((m) => ({
        id: m.id,
        sender: m.sender as ChatLine['sender'],
        body: m.body,
        createdAt: m.created_at,
      }));
    },
    refetchInterval: 30_000,
  });
}

/** `staff_send_message`. Errors: `chat_disabled`, `illegal_transition` (chat window over). */
export function useSendStaffMessage(visitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      const { data, error } = await supabase.rpc('staff_send_message', {
        p_visit_id: visitId,
        p_body: body,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
      return data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['console', 'chat', visitId] }),
  });
}

/** `staff_mark_read` for everything the guest has said so far. */
export function useMarkChatRead(visitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (upToId: number) => {
      const { error } = await supabase.rpc('staff_mark_read', {
        p_visit_id: visitId,
        p_up_to_id: upToId,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['console', 'chat-unread'] }),
  });
}

import { ERROR_CODES, type ErrorCode } from '@qm/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from '../../lib/live.ts';
import { supabase } from '../../lib/supabase.ts';
import { groupThreads, type Thread } from './threads.ts';

const key = (orgId: string) => ['dev-inbox', orgId] as const;
/** Fast enough that a message shows within 5 s of the dispatcher sending it. */
const POLL_MS = 3_000;
const LIMIT = 300;

async function loadThreads(orgId: string): Promise<Thread[]> {
  const [sent, replies] = await Promise.all([
    supabase
      .schema('app')
      .from('dev_inbox')
      .select('id, recipient, body, segments, created_at, notifications(status)')
      .eq('org_id', orgId)
      .eq('channel', 'sms')
      .order('id', { ascending: false })
      .limit(LIMIT),
    supabase
      .schema('app')
      .from('inbound_messages')
      .select('id, from_value_e164, body, received_at')
      .eq('org_id', orgId)
      .order('id', { ascending: false })
      .limit(LIMIT),
  ]);
  if (sent.error) throw new Error(sent.error.message);
  if (replies.error) throw new Error(replies.error.message);
  return groupThreads(
    sent.data.map((r) => ({
      id: r.id,
      recipient: r.recipient,
      body: r.body,
      segments: r.segments,
      status: r.notifications?.status ?? null,
      at: r.created_at,
    })),
    replies.data.map((r) => ({
      id: r.id,
      from: r.from_value_e164,
      body: r.body,
      at: r.received_at,
    })),
  );
}

/** Simulated SMS threads for the org, polled every few seconds. Admins only (RLS on dev_inbox). */
export function useDevInbox(orgId: string) {
  return useLiveQuery({
    topic: null,
    queryKey: key(orgId),
    queryFn: () => loadThreads(orgId),
    pollMs: () => POLL_MS,
    jitterMs: 0,
  });
}

/** Posts a reply typed as `from` to the dev-sms-inbound function. Resolves to stop, help or stored. */
export function useSendReply(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { from: string; body: string }) => {
      const { data, error } = await supabase.functions.invoke('dev-sms-inbound', {
        body: { org_id: orgId, from_e164: input.from, body: input.body },
      });
      if (error) {
        const response = (error as { context?: unknown }).context;
        const body = response instanceof Response ? await response.json().catch(() => null) : null;
        const code = (body as { error?: string } | null)?.error;
        throw new Error(
          code && (ERROR_CODES as readonly string[]).includes(code)
            ? (code as ErrorCode)
            : 'unknown',
        );
      }
      return (data as { action: string }).action;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(orgId) }),
  });
}

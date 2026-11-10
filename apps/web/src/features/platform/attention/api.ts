import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import type { OrgStatus } from '../api.ts';

// #1132: the support console's "needs attention" queue. The database decides who is on it, in what
// order and why (api.platform_attention); this only fetches and renders.

/** The rules the database knows; a new one it adds shows with the fallback text until worded. */
export type AttentionReason =
  | 'support_request_open'
  | 'payment_past_due'
  | 'sms_auto_paused'
  | 'pending_deletion'
  | 'message_failures'
  | 'device_offline'
  | 'plan_limit'
  | 'login_lockout'
  | 'stuck_onboarding'
  | 'no_recent_visits'
  | 'tagged_attention';

export interface AttentionItem {
  org_id: string;
  name: string;
  org_status: OrgStatus;
  reason: AttentionReason | (string & {});
  priority: number;
  /** When the condition began. */
  since: string | null;
  /** The numbers behind it, as private.platform_attention_raw documents per rule. */
  detail: Record<string, unknown>;
  /** Items open in total, before the page's limit. */
  total: number;
}

export const ATTENTION_LIMIT = 50;

/** Open items, most urgent first (`api.platform_attention`). */
export const attentionQuery = queryOptions({
  queryKey: ['platform', 'attention'],
  queryFn: async (): Promise<AttentionItem[]> => {
    const { data, error } = await supabase.rpc('platform_attention', { p_limit: ATTENTION_LIMIT });
    if (error) throw new Error(errorCode(error));
    return (data ?? []).map((r) => ({
      org_id: r.org_id!,
      name: r.name!,
      org_status: r.org_status as OrgStatus,
      reason: r.reason!,
      priority: r.priority!,
      since: r.since,
      detail: (r.detail ?? {}) as Record<string, unknown>,
      total: r.total!,
    }));
  },
  refetchInterval: 60_000,
});

/** Hides one (org, reason) for `hours` (1-720), audited; 0 shows it again (`api.platform_ack_attention`). */
export function useAckAttention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (a: { orgId: string; reason: string; hours: number }) => {
      const { error } = await supabase.rpc('platform_ack_attention', {
        p_org_id: a.orgId,
        p_reason: a.reason,
        p_hours: a.hours,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform', 'attention'] }),
  });
}

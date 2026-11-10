import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export type RequestStatus = 'open' | 'closed';

/** What `api.contact_support` keeps of a request's context; the database whitelists it. */
export interface RequestContext {
  route?: string;
  app_version?: string;
  browser?: string;
  viewport?: { w: number; h: number };
  online?: boolean;
  last_error_id?: string;
  org_name?: string;
  role?: string;
  plan?: string;
}

export interface SupportRequest {
  id: string;
  reference: string;
  user_email: string | null;
  subject: string;
  message: string;
  context: RequestContext;
  status: RequestStatus;
  created_at: string;
  closed_at: string | null;
}

/** The org's latest 100 support requests, newest first (`api.platform_list_support_requests`). */
export const supportRequestsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['platform', 'support-requests', orgId],
    queryFn: async (): Promise<SupportRequest[]> => {
      const { data, error } = await supabase.rpc('platform_list_support_requests', {
        p_org_id: orgId,
      });
      if (error) throw new Error(errorCode(error));
      return (data ?? []).map((r) => ({
        id: r.id!,
        reference: r.reference!,
        user_email: r.user_email,
        subject: r.subject!,
        message: r.message!,
        context: (r.context ?? {}) as RequestContext,
        status: r.status as RequestStatus,
        created_at: r.created_at!,
        closed_at: r.closed_at,
      }));
    },
  });

/** Closes or reopens a request (`api.platform_set_support_request_status`); repeating a status is a no-op. */
export function useSetSupportRequestStatus(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: { id: string; status: RequestStatus }) => {
      const { error } = await supabase.rpc('platform_set_support_request_status', {
        p_request_id: change.id,
        p_status: change.status,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: supportRequestsQuery(orgId).queryKey }),
  });
}

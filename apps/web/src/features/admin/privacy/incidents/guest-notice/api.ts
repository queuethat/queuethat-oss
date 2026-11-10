import type { Database } from '@qm/db-types';
import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../../lib/supabase.ts';

// #1276 (C10): the business's message to its own guests about an incident. The database owns the
// audience (guests in the window, resolved in SQL, never returned), the draft/approved/sent state,
// the owner-only approve and send, and the caps. The client renders what it is given.

export type GuestNotice = Database['api']['CompositeTypes']['guest_notice'];

const key = (logId: string) => ['admin', 'incident-log', 'guest-notices', logId] as const;

/** Notices for one log entry, newest first; each carries how many guests it reaches (open) or reached (sent). */
export const guestNoticesQuery = (logId: string) =>
  queryOptions({
    queryKey: key(logId),
    queryFn: async (): Promise<GuestNotice[]> => {
      const { data, error } = await supabase.rpc('list_guest_notices', { p_log_id: logId });
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

/** The business's locations (RLS-scoped to what this admin may read), for the notice's location filter. */
export const noticeLocationsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['admin', 'incident-log', 'guest-notice-locations', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('locations')
        .select('id, name')
        .eq('org_id', orgId)
        .order('name');
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

export interface NoticeDraft {
  subject: string;
  body: string;
  from: string;
  to: string;
  /** One location's guests only; empty for all of the business's locations. */
  locationId: string;
}

/** Saves the open notice (back to draft if it was approved). */
export function useSaveGuestNotice(logId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: NoticeDraft) => {
      const { error } = await supabase.rpc('save_guest_notice', {
        p_log_id: logId,
        p_subject: draft.subject,
        p_body: draft.body,
        p_window_from: draft.from,
        p_window_to: draft.to,
        p_location_id: draft.locationId || undefined,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(logId) }),
  });
}

/** Approves a draft, or sends an approved notice (owners only); nothing sends without both, in order. */
export function useAdvanceGuestNotice(logId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (step: { id: string; action: 'approve' | 'send' }) => {
      const { error } =
        step.action === 'approve'
          ? await supabase.rpc('approve_guest_notice', { p_id: step.id })
          : await supabase.rpc('send_guest_notice', { p_id: step.id });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(logId) }),
  });
}

import type { Database } from '@qm/db-types';
import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

// #1275 (C9): breach notices to tenants. The database owns the state (draft, approved, sent), the
// rule that only an approved notice goes out, the outbox and each business's acknowledgment.

export type IncidentNotice = Database['api']['CompositeTypes']['incident_notice'];

const noticesKey = (incidentId: string) =>
  ['platform', 'incidents', incidentId, 'notices'] as const;

/** The incident's notices, newest first, with how many businesses were told and acknowledged. */
export const noticesQuery = (incidentId: string) =>
  queryOptions({
    queryKey: noticesKey(incidentId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_list_notices', {
        p_incident_id: incidentId,
      });
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

/** Starts the draft from the template, or saves the given text over the open one (back to draft). */
export function useSaveNotice(incidentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: { subject?: string; body?: string }) => {
      const { error } = await supabase.rpc('platform_save_notice', {
        p_incident_id: incidentId,
        p_subject: text.subject,
        p_body: text.body,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: noticesKey(incidentId) }),
  });
}

/** Approves a draft, or sends an approved notice; nothing sends without both, in that order. */
export function useAdvanceNotice(incidentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (step: { id: string; action: 'approve' | 'send' }) => {
      const { error } =
        step.action === 'approve'
          ? await supabase.rpc('platform_approve_notice', { p_id: step.id })
          : await supabase.rpc('platform_send_notice', { p_id: step.id });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: noticesKey(incidentId) });
      void queryClient.invalidateQueries({ queryKey: ['platform', 'incidents'] });
    },
  });
}

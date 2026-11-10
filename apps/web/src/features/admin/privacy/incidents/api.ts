import type { Database } from '@qm/db-types';
import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

// #1275 (C9): the business's incident log. Reads are plain RLS selects (admins and owners); every
// write goes through an RPC.

const COLUMNS =
  'id, kind, title, description, data_categories, detected_at, people_affected, actions_taken, regulator_notified';

export type LogEntry = Pick<
  Database['app']['Tables']['org_incident_log']['Row'],
  | 'id'
  | 'kind'
  | 'title'
  | 'description'
  | 'data_categories'
  | 'detected_at'
  | 'people_affected'
  | 'actions_taken'
  | 'regulator_notified'
>;

export const KINDS = [
  'unauthorized_access',
  'data_exposure',
  'credential_compromise',
  'misdirected_message',
  'lost_device',
  'vendor_incident',
  'other',
] as const;

const logKey = (orgId: string) => ['admin', 'incident-log', orgId] as const;

/** The log, newest first. A business keeps it at least 24 months; nothing deletes a row. */
export const incidentLogQuery = (orgId: string) =>
  queryOptions({
    queryKey: logKey(orgId),
    queryFn: async (): Promise<LogEntry[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('org_incident_log')
        .select(COLUMNS)
        .eq('org_id', orgId)
        .order('detected_at', { ascending: false })
        .limit(500);
      if (error) throw new Error(errorCode(error));
      return data;
    },
  });

export interface LogPatch {
  description?: string;
  peopleAffected?: number;
  actionsTaken?: string;
  regulatorNotified?: string;
}

export function useUpdateLogEntry(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string } & LogPatch) => {
      const { error } = await supabase.rpc('update_incident_log_entry', {
        p_id: input.id,
        p_description: input.description,
        p_people_affected: input.peopleAffected,
        p_actions_taken: input.actionsTaken,
        p_regulator_notified: input.regulatorNotified,
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: logKey(orgId) }),
  });
}

export interface Report {
  kind: string;
  title: string;
  description: string;
}

/** Files a suspected incident as an entry in the business's own log. */
export function useReportIncident(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (r: Report) => {
      const { error } = await supabase.rpc('report_incident', {
        p_org_id: orgId,
        p_kind: r.kind,
        p_title: r.title,
        p_description: r.description,
        // The log is the business's own: nothing is sent to anyone else.
        p_notify_platform: false,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: logKey(orgId) }),
  });
}

const field = (v: string | number | null | undefined) => {
  // A leading = + - or @ would run as a formula in a spreadsheet; text a person typed can start with one.
  const raw = v == null ? '' : String(v);
  const s = /^[=+\-@\t]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** The whole log as CSV (one row per entry, UTC timestamps) for the 24-month record. */
export function logToCsv(headers: string[], rows: LogEntry[]): string {
  const lines = rows.map((r) =>
    [
      r.detected_at,
      r.kind,
      r.title,
      r.description,
      r.data_categories.join(';'),
      r.people_affected,
      r.actions_taken,
      r.regulator_notified,
    ]
      .map(field)
      .join(','),
  );
  return [headers.map(field).join(','), ...lines].join('\r\n') + '\r\n';
}

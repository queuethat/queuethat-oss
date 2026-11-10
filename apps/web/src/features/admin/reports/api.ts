import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** Only owners and admins manage report schedules; RLS and the RPCs enforce the same. */
export const canManageReports = (role: string | undefined) => role === 'admin' || role === 'owner';

export interface ReportSchedule {
  id: string;
  locationId: string;
  locationName: string;
  tz: string;
  frequency: 'daily' | 'weekly';
  /** ISO weekday, 1 = Monday; set for weekly schedules only. */
  weekday: number | null;
  /** Wall-clock `HH:MM:SS` in the location's zone. */
  sendAtLocal: string;
  recipients: string[];
  enabled: boolean;
  /** The database's answer; the page renders it and never works out schedules itself. */
  nextSendAt: string | null;
}

export interface ScheduleInput {
  locationId: string;
  frequency: 'daily' | 'weekly';
  weekday: number | null;
  sendAtLocal: string;
  recipients: string[];
  enabled: boolean;
}

const reportsKey = (orgId: string) => ['admin', 'report-schedules', orgId] as const;

/** `api.list_report_schedules`: schedules with their next send time. */
export const reportSchedulesQuery = (orgId: string) =>
  queryOptions({
    queryKey: reportsKey(orgId),
    queryFn: async (): Promise<ReportSchedule[]> => {
      const { data, error } = await supabase.rpc('list_report_schedules', { p_org_id: orgId });
      if (error) throw new Error(errorCode(error));
      return data.map((r) => ({
        id: r.id!,
        locationId: r.location_id!,
        locationName: r.location_name!,
        tz: r.tz!,
        frequency: r.frequency as ReportSchedule['frequency'],
        weekday: r.weekday,
        sendAtLocal: r.send_at_local!,
        recipients: r.recipients ?? [],
        enabled: !!r.enabled,
        nextSendAt: r.next_send_at,
      }));
    },
  });

const toRow = (orgId: string, input: ScheduleInput) => ({
  org_id: orgId,
  location_id: input.locationId,
  frequency: input.frequency,
  weekday: input.frequency === 'weekly' ? input.weekday : null,
  send_at_local: input.sendAtLocal,
  recipients: input.recipients,
  enabled: input.enabled,
});

/** Creates a schedule, or updates the one with `id`. Errors: `invalid_recipient`, `not_found`, `permission_denied`. */
export function useSaveSchedule(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ScheduleInput & { id?: string }) => {
      const table = supabase.schema('app').from('report_schedules');
      const { error } = input.id
        ? await table.update(toRow(orgId, input)).eq('id', input.id)
        : await table.insert(toRow(orgId, input));
      if (error) throw new Error(errorCode(error));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reportsKey(orgId) }),
  });
}

/** Pauses or resumes a schedule. */
export function useSetScheduleEnabled(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; enabled: boolean }) => {
      const { error } = await supabase
        .schema('app')
        .from('report_schedules')
        .update({ enabled: input.enabled })
        .eq('id', input.id);
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: reportsKey(orgId) }),
  });
}

export function useDeleteSchedule(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.schema('app').from('report_schedules').delete().eq('id', id);
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: reportsKey(orgId) }),
  });
}

/** `api.send_report_preview`: one report to the signed-in user. Errors: `not_found`, `rate_limited`. */
export function useSendPreview() {
  return useMutation({
    mutationFn: async (scheduleId: string) => {
      const { error } = await supabase.rpc('send_report_preview', { p_schedule_id: scheduleId });
      if (error) throw new Error(errorCode(error));
    },
  });
}

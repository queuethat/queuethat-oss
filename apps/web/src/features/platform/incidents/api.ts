import { errorCode } from '@qm/domain';
import type { Database } from '@qm/db-types';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

// #1274 (C8): the platform incident register. One hook per RPC; the database decides who may call
// them (operator + aal2), owns the 72-hour clock (`notify_state`, `escalated`) and the timeline.

export type Incident = Database['api']['CompositeTypes']['platform_incident'];
export type IncidentStatus = Database['app']['Enums']['incident_status'];
export type IncidentTenant = Database['api']['CompositeTypes']['platform_incident_tenant'];
export type BreakGlassOpening = Database['api']['CompositeTypes']['platform_incident_break_glass'];

export const KINDS = [
  'unauthorized_access',
  'data_exposure',
  'credential_compromise',
  'misdirected_message',
  'lost_device',
  'vendor_incident',
  'other',
] as const;
export const CATEGORIES = [
  'contact',
  'visit_history',
  'form_answers',
  'sensitive_answers',
  'payment',
  'credentials',
  'other',
] as const;
export const STATUSES: IncidentStatus[] = ['suspected', 'contained', 'resolved'];

function failed(error: unknown): never {
  throw new Error(errorCode(error));
}

/** Incidents, newest first, with the notify deadline and escalation flag; refreshed every minute. */
export const incidentsQuery = queryOptions({
  queryKey: ['platform', 'incidents'],
  queryFn: async () => {
    const { data, error } = await supabase.rpc('platform_list_incidents');
    if (error) failed(error);
    return data;
  },
  refetchInterval: 60_000,
});

/** One incident's timeline, oldest first (RLS: operator + aal2). */
export const incidentTimelineQuery = (id: string) =>
  queryOptions({
    queryKey: ['platform', 'incidents', id, 'timeline'],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('platform_incident_events')
        .select('id, kind, body, created_at')
        .eq('incident_id', id)
        .order('created_at');
      if (error) failed(error);
      return data;
    },
  });

/** The scoped orgs with their owners and breach contacts. */
export const incidentTenantsQuery = (id: string) =>
  queryOptions({
    queryKey: ['platform', 'incidents', id, 'tenants'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_incident_tenants', { p_id: id });
      if (error) failed(error);
      return data;
    },
  });

/** Break-glass openings on the scoped orgs around the incident. */
export const incidentBreakGlassQuery = (id: string) =>
  queryOptions({
    queryKey: ['platform', 'incidents', id, 'break-glass'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_incident_break_glass', { p_id: id });
      if (error) failed(error);
      return data;
    },
  });

export interface NewIncident {
  kind: string;
  title: string;
  description: string;
  orgIds: string[];
  categories: string[];
  recordCount: number | undefined;
}

export function useCreateIncident() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (i: NewIncident) => {
      const { error } = await supabase.rpc('platform_create_incident', {
        p_kind: i.kind,
        p_title: i.title,
        p_description: i.description,
        p_org_ids: i.orgIds,
        p_data_categories: i.categories,
        p_record_count: i.recordCount,
      });
      if (error) failed(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['platform', 'incidents'] }),
  });
}

export type IncidentPatch = Partial<{
  status: IncidentStatus;
  containment: string;
  rootCause: string;
  lessons: string;
  recordCount: number;
  markNotified: boolean;
  waiveReason: string;
}>;

export function useUpdateIncident(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (p: IncidentPatch) => {
      const { error } = await supabase.rpc('platform_update_incident', {
        p_id: id,
        p_status: p.status,
        p_containment: p.containment,
        p_root_cause: p.rootCause,
        p_lessons: p.lessons,
        p_record_count: p.recordCount,
        p_mark_notified: p.markNotified,
        p_waive_reason: p.waiveReason,
      });
      if (error) failed(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['platform', 'incidents'] }),
  });
}

export function useAddIncidentNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      const { error } = await supabase.rpc('platform_add_incident_note', {
        p_id: id,
        p_body: body,
      });
      if (error) failed(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['platform', 'incidents'] }),
  });
}

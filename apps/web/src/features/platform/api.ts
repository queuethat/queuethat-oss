import type { Database } from '@qm/db-types';
import { errorCode } from '@qm/domain';
import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.ts';
import type { FunnelFilter, FunnelStage, StuckStage } from './funnel.ts';

// PLT10 (#416): the operator console's reads. One query per RPC; all but platform_whoami need a
// platform role and an aal2 session, which the /platform layout guarantees before they run.

export type OrgStatus = Database['app']['Enums']['org_status'];
/**
 * `api.platform_org_row`. Generated composite types make every field nullable; these are the
 * ones the RPC can actually leave null (an org with no location, owner or visits yet).
 */
export interface OrgRow {
  id: string;
  name: string;
  slug: string | null;
  status: OrgStatus;
  created_at: string;
  owner_email: string | null;
  last_activity_at: string | null;
  visits_7d: number;
  notifications_sent_7d: number;
  notifications_failed_7d: number;
  members: number;
  locations: number;
}

/** Directory page size. */
export const ORGS_PAGE = 50;

/**
 * The caller's platform role (`api.platform_whoami`), or null for everyone else. Needs no MFA,
 * so an aal1 operator can be sent to enrolment; every other platform RPC also requires aal2.
 */
export const platformRoleQuery = (userId: string) =>
  queryOptions({
    queryKey: ['platform', 'role', userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_whoami');
      if (error) throw new Error(errorCode(error));
      return data;
    },
    staleTime: 60_000,
  });

export interface OrgsFilter {
  q?: string | undefined;
  status?: OrgStatus | undefined;
  /** The last id of the previous page. */
  after?: string | undefined;
}

/** One page of the tenant directory (`api.platform_list_orgs`), ordered by id. */
export const orgsQuery = ({ q, status, after }: OrgsFilter) =>
  queryOptions({
    queryKey: ['platform', 'orgs', q ?? '', status ?? null, after ?? null],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_list_orgs', {
        p_search: q ?? '',
        p_limit: ORGS_PAGE,
        ...(status ? { p_status: status } : {}),
        ...(after ? { p_after: after } : {}),
      });
      if (error) throw new Error(errorCode(error));
      return data as OrgRow[];
    },
  });

interface Member {
  user_id: string;
  email: string;
  role: string;
  created_at: string;
}
interface Location {
  id: string;
  name: string;
  slug: string;
  tz: string;
  queues: { id: string; name: string; manual_state: string; archived: boolean }[];
}
interface Device {
  id: string;
  kind: string;
  name: string;
  last_seen_at: string | null;
  app_version: string | null;
  revoked_at: string | null;
}
interface AuditRow {
  id: number;
  actor: string | null;
  role: string | null;
  action: string;
  table_name: string;
  at: string;
}
interface SupportGrant {
  id: string;
  scope: 'read' | 'act';
  reason: string;
  break_glass: boolean;
  expires_at: string;
}

/** `api.platform_org_detail` with its jsonb parts typed as the RPC's comment documents them. */
export interface OrgDetail {
  org: OrgRow;
  suspended_reason: string | null;
  suspended_at: string | null;
  members: Member[];
  locations: Location[];
  devices: Device[];
  recent_audit: AuditRow[];
  support_grant: SupportGrant | null;
}

/** One tenant's detail (`api.platform_get_org`): aggregates and staff data, never guest data. */
export const orgQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['platform', 'org', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_get_org', { p_org_id: orgId });
      if (error) throw new Error(errorCode(error));
      return data as unknown as OrgDetail;
    },
  });

// #1136: visit lookup under a support grant. Both RPCs are denied without a live grant, so a
// failure is shown as a "request access" state; every call is audited by the database.

/** `api.platform_search_visits` row. */
export interface VisitHit {
  visit_id: string;
  display_ticket: string;
  queue_name: string;
  location_name: string;
  service_day: string;
  status: Database['api']['Enums']['visit_state'];
  joined_at: string;
  finished_at: string | null;
}

export interface VisitSearch {
  ticket: string;
  /** A local service day, `YYYY-MM-DD`, or empty. */
  day: string;
  status: Database['api']['Enums']['visit_state'] | '';
}

/** Searches one tenant's visits (`api.platform_search_visits`). Run on submit, never on mount. */
export const visitSearchQuery = (orgId: string, search: VisitSearch, run = 0) =>
  queryOptions({
    queryKey: ['platform', 'visit-search', orgId, search, run],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_search_visits', {
        p_org_id: orgId,
        ...(search.ticket.trim() ? { p_ticket: search.ticket.trim() } : {}),
        ...(search.day ? { p_service_day: search.day } : {}),
        ...(search.status ? { p_status: search.status } : {}),
      });
      if (error) throw new Error(errorCode(error));
      return data as unknown as VisitHit[];
    },
    // Each fetch is an audited lookup: never refetch on focus or remount.
    staleTime: Infinity,
    retry: false,
  });

export interface TimelineEvent {
  id: number;
  type: string;
  from_status: string | null;
  to_status: string;
  actor_kind: 'guest' | 'staff' | 'system' | 'device' | 'platform';
  occurred_at: string;
  undone: boolean;
  via_support: boolean;
  undoes_type: string | null;
}
export interface TimelineNotification {
  id: string;
  event_id: number | null;
  channel: string;
  template_key: string;
  category: string;
  status: string;
  attempts: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  /** Masked contact or the channel name; never a raw address. */
  recipient: string;
}
export interface TimelineGrant {
  id: string;
  scope: 'read' | 'act';
  reason: string;
  break_glass: boolean;
  created_at: string;
  expires_at: string;
}

/** `api.platform_visit_timeline` with its jsonb parts typed as the RPC's comment documents them. */
export interface VisitTimeline {
  visit_id: string;
  display_ticket: string;
  status: string;
  queue_name: string;
  location_name: string;
  tz: string;
  service_day: string;
  source: string;
  party_size: number;
  call_count: number;
  joined_at: string;
  finished_at: string | null;
  support_grant: TimelineGrant;
  events: TimelineEvent[];
  notifications: TimelineNotification[];
}

/** One visit's history (`api.platform_visit_timeline`). Audited on every fetch. */
export const visitTimelineQuery = (orgId: string, visitId: string) =>
  queryOptions({
    queryKey: ['platform', 'visit-timeline', orgId, visitId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_visit_timeline', {
        p_org_id: orgId,
        p_visit_id: visitId,
      });
      if (error) throw new Error(errorCode(error));
      return data as unknown as VisitTimeline;
    },
    staleTime: Infinity,
    retry: false,
  });

/** One `api.platform_org_activation` row; the database derives every field. */
export interface Activation {
  org_id: string;
  org_status: OrgStatus;
  stage: StuckStage | 'first_served';
  next_stage: FunnelStage | null;
  reached_at: string;
  /** Whole days at `stage`; null once `first_served` is reached. */
  stuck_days: number | null;
  is_stuck: boolean;
  stages: { stage: FunnelStage; reached_at: string | null }[];
}

/** `api.platform_funnel`: stage counts for tenants created in a range, and who is stuck. */
export interface Funnel {
  from_date: string;
  to_date: string;
  stages: {
    stage: FunnelStage;
    count: number;
    conversion_prev: number | null;
    conversion_start: number | null;
  }[];
  signups_without_business: number;
  stuck_total: number;
  stuck: {
    org_id: string;
    name: string;
    owner_email: string | null;
    stage: StuckStage;
    reached_at: string;
    stuck_days: number;
  }[];
}

/** Stuck tenants per page. */
export const STUCK_PAGE = 25;

/** The funnel for UTC days `from`..`to` (default: the last 30), one page of stuck tenants. */
export const funnelQuery = ({ from, to, stage, page = 0 }: FunnelFilter) =>
  queryOptions({
    queryKey: ['platform', 'funnel', from ?? null, to ?? null, stage ?? null, page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_funnel', {
        p_limit: STUCK_PAGE,
        p_offset: page * STUCK_PAGE,
        ...(from ? { p_from: from } : {}),
        ...(to ? { p_to: to } : {}),
        ...(stage ? { p_stage: stage } : {}),
      });
      if (error) throw new Error(errorCode(error));
      return data as unknown as Funnel;
    },
  });

/** Activation of up to 200 tenants (`api.platform_org_activation`), keyed by org id. */
export const activationQuery = (orgIds: string[]) =>
  queryOptions({
    queryKey: ['platform', 'activation', ...orgIds],
    enabled: orgIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('platform_org_activation', { p_org_ids: orgIds });
      if (error) throw new Error(errorCode(error));
      return new Map((data as unknown as Activation[]).map((a) => [a.org_id, a]));
    },
  });

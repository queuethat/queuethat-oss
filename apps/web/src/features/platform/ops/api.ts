import { errorCode } from '@qm/domain';
import type { Database, Json } from '@qm/db-types';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

// PLT13 (#419): the operator console's ops pages. Each RPC or table read has one hook here;
// the database decides who may call them (support reads, operator writes, aal2 for both).

/** Why an ops call failed, as the code the page translates. */
function failed(error: unknown): never {
  throw new Error(errorCode(error));
}

const KNOWN_ERRORS = ['permission_denied', 'invalid_input', 'not_found'] as const;

/** A failed write's code as the pages word it; anything else is `unknown`. */
export function opsError(error: Error): (typeof KNOWN_ERRORS)[number] | 'unknown' {
  return KNOWN_ERRORS.find((code) => code === error.message) ?? 'unknown';
}

export type PlatformHealth = Database['api']['CompositeTypes']['platform_health'];

export interface CronJob {
  name: string;
  schedule: string;
  active: boolean;
  last_start: string | null;
  /** pg_cron's last run status, e.g. `succeeded` or `failed`; null before the first run. */
  last_status: string | null;
  /** Why the last run failed (first 200 characters); null unless it failed. */
  last_message: string | null;
}

/** Platform health right now (`api.platform_health`), refreshed every 30 seconds. */
export const platformHealthQuery = queryOptions({
  queryKey: ['platform', 'health'],
  queryFn: async () => {
    const { data, error } = await supabase.rpc('platform_health');
    if (error) failed(error);
    return { ...data, cron_jobs: (data.cron_jobs ?? []) as unknown as CronJob[] };
  },
  refetchInterval: 30_000,
});

/** Most businesses the per-business table can name; the directory RPC's largest page. */
export const ORG_NAMES = 200;

/**
 * Business names by id, from the directory (`api.platform_list_orgs`), for tables that only carry
 * ids. Past the first 200 businesses a row falls back to its id; the row still links to its page.
 */
export const orgNamesQuery = queryOptions({
  queryKey: ['platform', 'org-names'],
  queryFn: async () => {
    const { data, error } = await supabase.rpc('platform_list_orgs', {
      p_search: '',
      p_limit: ORG_NAMES,
    });
    if (error) failed(error);
    return new Map(data.map((org) => [org.id ?? '', org.name ?? '']));
  },
  staleTime: 60_000,
});

export type DailyStats = Database['app']['Tables']['platform_daily_stats']['Row'];

/** The nightly rollup rows for UTC days `from`..`to` (`api.platform_stats`). */
export const platformStatsQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: ['platform', 'stats', from, to],
    queryFn: async (): Promise<DailyStats[]> => {
      const { data, error } = await supabase.rpc('platform_stats', { p_from: from, p_to: to });
      if (error) failed(error);
      return data;
    },
  });

/**
 * Every entitlement key with its default, and this org's overrides. Platform roles read both
 * tables under RLS; tenants never do.
 */
export const orgEntitlementsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['platform', 'entitlements', orgId],
    queryFn: async () => {
      const [defaults, overrides] = await Promise.all([
        supabase
          .schema('app')
          .from('entitlement_defaults')
          .select('key, value, description')
          .order('key'),
        supabase
          .schema('app')
          .from('org_entitlements')
          .select('key, value, reason, set_at')
          .eq('org_id', orgId),
      ]);
      if (defaults.error) failed(defaults.error);
      if (overrides.error) failed(overrides.error);
      return { defaults: defaults.data, overrides: overrides.data };
    },
  });

/**
 * Operator only: sets the org's override for `key` (`api.platform_set_entitlement`), or clears it
 * when `value` is null so the default applies again. Audited with `reason`.
 */
export function useSetEntitlement(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { key: string; value: Json | null; reason: string }) => {
      const { error } = await supabase.rpc('platform_set_entitlement', {
        p_org_id: orgId,
        p_key: input.key,
        p_value: input.value,
        p_reason: input.reason,
      });
      if (error) failed(error);
    },
    onSettled: () => queryClient.invalidateQueries(orgEntitlementsQuery(orgId)),
  });
}

/** `api.platform_sms_health`: the org's platform SMS pause state and last-24h counts. */
export interface SmsHealth {
  platform_mode: boolean;
  state?: 'auto' | 'manual' | 'resumed';
  reason?: string;
  set_at?: string;
  stats_24h: { sent: number; filtered: number; undelivered: number; stops: number };
}

export const smsHealthQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['platform', 'sms-health', orgId],
    queryFn: async (): Promise<SmsHealth> => {
      const { data, error } = await supabase.rpc('platform_sms_health', { p_org_id: orgId });
      if (error) failed(error);
      return data as unknown as SmsHealth;
    },
  });

/** Operator only: pauses or resumes the org's platform SMS (`api.platform_set_sms_pause`). Audited. */
export function useSetSmsPause(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { pause: boolean; reason: string }) => {
      const { error } = await supabase.rpc('platform_set_sms_pause', {
        p_org_id: orgId,
        p_pause: input.pause,
        p_reason: input.reason,
      });
      if (error) failed(error);
    },
    onSettled: () => queryClient.invalidateQueries(smsHealthQuery(orgId)),
  });
}

export type AnnouncementSeverity = Database['app']['Enums']['announcement_severity'];

/** Announcements live or scheduled, earliest first (`api.platform_list_announcements`). */
export const platformAnnouncementsQuery = queryOptions({
  queryKey: ['platform', 'announcements'],
  queryFn: async () => {
    const { data, error } = await supabase.rpc('platform_list_announcements');
    if (error) failed(error);
    return data;
  },
});

export type PlatformAnnouncement = Awaited<
  ReturnType<NonNullable<(typeof platformAnnouncementsQuery)['queryFn']>>
>[number];

/**
 * Operator only: creates an announcement, or replaces announcement `id`
 * (`api.platform_upsert_announcement`). End one early by saving it with `endsAt` now.
 */
export function useUpsertAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string;
      severity: AnnouncementSeverity;
      message: string;
      startsAt?: string;
      endsAt: string;
    }) => {
      const { error } = await supabase.rpc('platform_upsert_announcement', {
        p_severity: input.severity,
        p_message: input.message,
        p_ends_at: input.endsAt,
        p_starts_at: input.startsAt,
        p_id: input.id,
      });
      if (error) failed(error);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries(platformAnnouncementsQuery),
        queryClient.invalidateQueries({ queryKey: ['announcements'] }),
      ]),
  });
}

/** Platform blocks cover typed phone and email only; telegram contacts are unlinked, not blocked. */
export type BlockKind = Exclude<Database['app']['Enums']['contact_channel'], 'telegram'>;

/**
 * Blocked contacts as the console may show them: kind, reason, expiry. The table holds only an
 * HMAC of each contact (PLT8), so there is nothing else to read; the hash is not selected either.
 * Support and operators read it under RLS. Expired blocks stay until removed, so the page marks them.
 */
export const platformBlocksQuery = queryOptions({
  queryKey: ['platform', 'blocks'],
  queryFn: async () => {
    const { data, error } = await supabase
      .schema('app')
      .from('platform_blocks')
      .select('kind, reason, created_at, expires_at')
      .order('created_at', { ascending: false });
    if (error) failed(error);
    return data;
  },
});

export type PlatformBlock = Awaited<
  ReturnType<NonNullable<(typeof platformBlocksQuery)['queryFn']>>
>[number];

/** Why a write failed, as the code the blocks page words. */
function blockFailed(error: { details?: unknown } | null): never {
  // The reason must not carry the contact; the database says so in DETAIL, not in the message.
  if (error?.details === 'reason_contains_contact') throw new Error('reason_contains_contact');
  return failed(error);
}

/**
 * Operator only: blocks a phone (E.164) or email from every queue (`api.platform_block_contact`).
 * The value goes to the server to be hashed and is never stored, shown or logged by the page.
 * `expiresAt` null blocks until removed.
 */
export function useBlockContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      kind: BlockKind;
      value: string;
      reason: string;
      expiresAt: string | null;
    }) => {
      const { error } = await supabase.rpc('platform_block_contact', {
        p_value: input.value,
        p_kind: input.kind,
        p_reason: input.reason,
        // The generated type has no null for a nullable timestamptz argument.
        p_expires_at: input.expiresAt as string,
      });
      if (error) blockFailed(error);
    },
    onSettled: () => queryClient.invalidateQueries(platformBlocksQuery),
  });
}

/**
 * Operator only: removes the block on a contact (`api.platform_unblock_contact`). The list can't
 * name a row's contact, so the operator types it again; removing one that isn't blocked is a no-op.
 */
export function useUnblockContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: BlockKind; value: string }) => {
      const { error } = await supabase.rpc('platform_unblock_contact', {
        p_value: input.value,
        p_kind: input.kind,
      });
      if (error) blockFailed(error);
    },
    onSettled: () => queryClient.invalidateQueries(platformBlocksQuery),
  });
}

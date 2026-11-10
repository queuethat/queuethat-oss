/* eslint-disable no-restricted-properties -- `channel` is a database column here, not a Realtime channel */
import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export const PAID_CHANNELS = ['sms', 'whatsapp'] as const;
export type PaidChannel = (typeof PAID_CHANNELS)[number];

/** What the database assumes for an org that never saved limits (api.reserve_send). */
export const DEFAULT_DAILY_CAP = 200;

export interface UsageRow {
  day: string;
  kind: string;
  provider: string;
  messages: number;
  segments: number;
  costMicros: number;
  currency: string;
}

export interface ChannelLimit {
  dailyCap: number;
  monthlyBudgetMicros: number | null;
  countryAllowlist: string[];
}

const key = (orgId: string) => ['admin', 'usage', orgId];

/** Sent messages, segments and cost per UTC day, channel and provider, from `api.usage_summary`. */
export const usageSummaryQuery = (orgId: string, from: string, to: string) =>
  queryOptions({
    queryKey: [...key(orgId), 'summary', from, to],
    queryFn: async (): Promise<UsageRow[]> => {
      const { data, error } = await supabase.rpc('usage_summary', {
        p_org_id: orgId,
        p_from: from,
        p_to: to,
      });
      if (error) throw new Error(errorCode(error));
      return data.map((r) => ({
        day: r.day ?? '',
        kind: r.channel ?? '',
        provider: r.provider ?? '',
        messages: r.messages ?? 0,
        segments: r.segments ?? 0,
        costMicros: Number(r.cost_micros ?? 0),
        currency: r.currency ?? 'USD',
      }));
    },
  });

/** Today's reserved sends per paid channel (`app.usage_counters`, UTC day). */
export const todayCountsQuery = (orgId: string, day: string) =>
  queryOptions({
    queryKey: [...key(orgId), 'today', day],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase
        .schema('app')
        .from('usage_counters')
        .select('channel, sent')
        .eq('org_id', orgId)
        .eq('day', day);
      if (error) throw error;
      return Object.fromEntries(data.map((r) => [r.channel, r.sent]));
    },
  });

/** Saved caps, budget and allowed countries per paid channel; a missing channel has the defaults. */
export const limitsQuery = (orgId: string) =>
  queryOptions({
    queryKey: [...key(orgId), 'limits'],
    queryFn: async (): Promise<Record<string, ChannelLimit>> => {
      const { data, error } = await supabase
        .schema('app')
        .from('channel_limits')
        .select('channel, daily_cap, monthly_budget_micros, country_allowlist')
        .eq('org_id', orgId);
      if (error) throw error;
      return Object.fromEntries(
        data.map((r) => [
          r.channel,
          {
            dailyCap: r.daily_cap,
            monthlyBudgetMicros:
              r.monthly_budget_micros === null ? null : Number(r.monthly_budget_micros),
            countryAllowlist: r.country_allowlist,
          },
        ]),
      );
    },
  });

/** Admins and owners only: RLS refuses everyone else's write. One allowlist and budget for both channels. */
export function useSaveLimits(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      caps: Record<PaidChannel, number>;
      budgetMicros: number | null;
      countries: string[];
    }) => {
      const { error } = await supabase
        .schema('app')
        .from('channel_limits')
        .upsert(
          PAID_CHANNELS.map((channel) => ({
            org_id: orgId,
            channel,
            daily_cap: v.caps[channel],
            monthly_budget_micros: v.budgetMicros,
            country_allowlist: v.countries,
          })),
          { onConflict: 'org_id,channel' },
        );
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(orgId) }),
  });
}

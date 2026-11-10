import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

// Booking settings of one service (A-2, A-3, A-5): the policy row and its capacity rules, read
// and written under RLS (staff read, managers write).

/** What an admin edits in app.booking_policies. `durationMinutes` null = the service's expected minutes. */
export interface PolicySettings {
  bookable: boolean;
  slotMinutes: number;
  slotOffsetMinutes: number;
  durationMinutes: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
}

/** The database defaults, shown for a service that has no policy row yet. */
export const DEFAULT_POLICY: PolicySettings = {
  bookable: false,
  slotMinutes: 30,
  slotOffsetMinutes: 0,
  durationMinutes: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 60,
  maxDaysAhead: 30,
};

export interface CapacityRule {
  id: string;
  scope: 'slot' | 'day';
  weekday: number | null;
  localDate: string | null;
  capacity: number;
}

const policyKey = (serviceId: string) => ['admin', 'booking-policy', serviceId];
const rulesKey = (serviceId: string) => ['admin', 'capacity-rules', serviceId];

export const policyQuery = (serviceId: string) =>
  queryOptions({
    queryKey: policyKey(serviceId),
    queryFn: async (): Promise<PolicySettings> => {
      const { data, error } = await supabase
        .schema('app')
        .from('booking_policies')
        .select('*')
        .eq('service_id', serviceId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return DEFAULT_POLICY;
      return {
        bookable: data.bookable,
        slotMinutes: data.slot_minutes,
        slotOffsetMinutes: data.slot_offset_minutes,
        durationMinutes: data.duration_minutes,
        bufferBeforeMinutes: data.buffer_before_minutes,
        bufferAfterMinutes: data.buffer_after_minutes,
        minNoticeMinutes: data.min_notice_minutes,
        maxDaysAhead: data.max_days_ahead,
      };
    },
  });

export const capacityRulesQuery = (serviceId: string) =>
  queryOptions({
    queryKey: rulesKey(serviceId),
    queryFn: async (): Promise<CapacityRule[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('capacity_rules')
        .select('id, scope, weekday, local_date, capacity')
        .eq('service_id', serviceId)
        .order('scope')
        .order('local_date', { nullsFirst: true })
        .order('weekday', { nullsFirst: true });
      if (error) throw error;
      return data.map((r) => ({
        id: r.id,
        scope: r.scope,
        weekday: r.weekday,
        localDate: r.local_date,
        capacity: r.capacity,
      }));
    },
  });

interface Target {
  orgId: string;
  locationId: string;
  serviceId: string;
}

/** Saves the policy (creating it on first save) and drops cached previews, which it changes. */
export function useSavePolicy(target: Target) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (s: PolicySettings) => {
      const { error } = await supabase.schema('app').from('booking_policies').upsert(
        {
          org_id: target.orgId,
          location_id: target.locationId,
          service_id: target.serviceId,
          bookable: s.bookable,
          slot_minutes: s.slotMinutes,
          slot_offset_minutes: s.slotOffsetMinutes,
          duration_minutes: s.durationMinutes,
          buffer_before_minutes: s.bufferBeforeMinutes,
          buffer_after_minutes: s.bufferAfterMinutes,
          min_notice_minutes: s.minNoticeMinutes,
          max_days_ahead: s.maxDaysAhead,
        },
        { onConflict: 'service_id' },
      );
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: policyKey(target.serviceId) });
      await queryClient.invalidateQueries({ queryKey: ['booking', 'slots'] });
    },
  });
}

/** Adds or removes a capacity rule. A second rule for the same scope and day is `duplicate`. */
export function useChangeCapacity(target: Target) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      change: { kind: 'add'; rule: Omit<CapacityRule, 'id'> } | { kind: 'remove'; id: string },
    ) => {
      const rules = supabase.schema('app').from('capacity_rules');
      const { error } =
        change.kind === 'add'
          ? await rules.insert({
              org_id: target.orgId,
              location_id: target.locationId,
              service_id: target.serviceId,
              scope: change.rule.scope,
              weekday: change.rule.weekday,
              local_date: change.rule.localDate,
              capacity: change.rule.capacity,
            })
          : await rules.delete().eq('id', change.id);
      if (error) throw new Error(error.code === '23505' ? 'duplicate' : error.message);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: rulesKey(target.serviceId) });
      await queryClient.invalidateQueries({ queryKey: ['booking', 'slots'] });
    },
  });
}

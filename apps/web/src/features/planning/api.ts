import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from '../../lib/live.ts';
import { supabase } from '../../lib/supabase.ts';
import { addDays } from '../booking/slots.ts';
import type { AppointmentRow } from '../appointments/api.ts';
import { uuid } from '../guest/api.ts';
import { parseRange } from './grid.ts';

// Staff access to the planning grid: one read of everything a day or week shows.

export interface PlanningResource {
  id: string;
  label: string;
  kind: string;
  member_user_id: string | null;
}

/** api.shift_row */
export interface PlanningShift {
  id: string;
  user_id: string;
  counter_id: string | null;
  starts_at: string;
  ends_at: string;
  note: string | null;
}

export interface PlanningBlock {
  id: string;
  counter_id: string;
  start: string;
  end: string;
  reason: string | null;
}

export interface PlanningData {
  resources: PlanningResource[];
  appointments: AppointmentRow[];
  shifts: PlanningShift[];
  blocks: PlanningBlock[];
  serviceResources: { service_id: string; counter_id: string }[];
  services: Map<string, string>;
}

/**
 * Resources, appointments, shifts and blocks of a location for local dates `from`..`to`
 * (inclusive, at most 31 days). Refetches on every location signal; appointments and blocks do not
 * signal, so it also polls every few seconds.
 */
export function usePlanning(locationId: string | undefined, from: string, to: string) {
  return useLiveQuery({
    topic: locationId ? `loc:${locationId}` : null,
    jitterMs: 0,
    pollMs: () => 5_000,
    enabled: !!locationId,
    queryKey: ['planning', locationId, from, to],
    queryFn: async (): Promise<PlanningData> => {
      const app = supabase.schema('app');
      // Blocks are range-filtered by a day of slack either side so a timezone edge is not lost.
      const window = `[${addDays(from, -1)}T00:00:00Z,${addDays(to, 2)}T00:00:00Z)`;
      const [resources, appointments, shifts, blocks, mapping, services] = await Promise.all([
        app
          .from('counters')
          .select('id, label, kind, member_user_id')
          .eq('location_id', locationId!)
          .eq('active', true)
          .order('label'),
        supabase.rpc('list_appointments', { p_location_id: locationId!, p_from: from, p_to: to }),
        supabase.rpc('list_shifts', { p_location_id: locationId!, p_from_day: from, p_to_day: to }),
        app
          .from('time_blocks')
          .select('id, counter_id, during, reason')
          .eq('location_id', locationId!)
          .overlaps('during', window),
        app
          .from('service_resources')
          .select('service_id, counter_id')
          .eq('location_id', locationId!),
        app.from('services').select('id, name').eq('location_id', locationId!),
      ]);
      for (const r of [resources, appointments, shifts, blocks, mapping, services]) {
        if (r.error) throw r.error;
      }
      return {
        resources: resources.data as PlanningResource[],
        appointments: (appointments.data as unknown as AppointmentRow[]).filter(
          (a) => a.status !== 'cancelled' && a.status !== 'no_show',
        ),
        shifts: shifts.data as unknown as PlanningShift[],
        blocks: (blocks.data ?? []).flatMap((b) => {
          const range = parseRange(b.during);
          return range ? [{ id: b.id, counter_id: b.counter_id, ...range, reason: b.reason }] : [];
        }),
        serviceResources: mapping.data ?? [],
        services: new Map((services.data ?? []).map((s) => [s.id, s.name])),
      };
    },
  });
}

/** api.bulk_block_result: the created block ids and the bookings that overlap them. */
export interface BulkBlockResult {
  block_ids: string[];
  conflicts: string[];
}

/** Blocks every resource over one range in a single call. */
export function useBlockTime(locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      resourceIds: string[];
      start: Date;
      end: Date;
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc('block_time_bulk', {
        p_location_id: locationId,
        p_resource_ids: input.resourceIds,
        p_ranges: [`[${input.start.toISOString()},${input.end.toISOString()})`],
        p_reason: input.reason,
        p_idempotency_key: uuid(),
      });
      if (error) throw error;
      return data as unknown as BulkBlockResult;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['planning'] }),
  });
}

/** Undoes a block: blocks may be deleted, appointments never are. */
export function useUnblockTime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (blockIds: string[]) => {
      const { error } = await supabase.rpc('delete_time_blocks', {
        p_block_ids: blockIds,
        p_idempotency_key: uuid(),
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['planning'] }),
  });
}

import { atLocalTime, localTimeValue } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface Shift {
  id: string;
  userId: string;
  counterId: string | null;
  /** The service day the shift starts in (the database's rule: location tz and day boundary). */
  serviceDay: string;
  startsAt: string;
  endsAt: string;
  note: string | null;
}

/** Shifts of a location whose service day falls in the range, from `api.list_shifts`. */
export const shiftsQuery = (locationId: string, fromDay: string, toDay: string) =>
  queryOptions({
    queryKey: ['admin', 'shifts', locationId, fromDay, toDay],
    queryFn: async (): Promise<Shift[]> => {
      const { data, error } = await supabase.rpc('list_shifts', {
        p_location_id: locationId,
        p_from_day: fromDay,
        p_to_day: toDay,
      });
      if (error) throw error;
      return data.map((s) => ({
        id: s.id ?? '',
        userId: s.user_id ?? '',
        counterId: s.counter_id,
        serviceDay: s.service_day ?? '',
        startsAt: s.starts_at ?? '',
        endsAt: s.ends_at ?? '',
        note: s.note,
      }));
    },
  });

export interface ShiftInput {
  id?: string;
  orgId: string;
  locationId: string;
  userId: string;
  counterId: string | null;
  /** YYYY-MM-DD on the location's calendar. */
  day: string;
  /** HH:mm local; an end at or before the start means the next day. */
  start: string;
  end: string;
  timeZone: string;
  note: string;
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The instant of `hhmm` on the location's wall clock on `day`. */
export const instantOn = (day: string, hhmm: string, timeZone: string) =>
  atLocalTime(hhmm, new Date(`${day}T12:00:00Z`), timeZone);

const range = (from: Date, to: Date) => `[${from.toISOString()},${to.toISOString()})`;

/** Adds or updates one shift; the database refuses a person's overlapping shifts. */
export function useSaveShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (s: ShiftInput) => {
      const from = instantOn(s.day, s.start, s.timeZone);
      const to = instantOn(s.end > s.start ? s.day : addDays(s.day, 1), s.end, s.timeZone);
      const row = {
        org_id: s.orgId,
        location_id: s.locationId,
        user_id: s.userId,
        counter_id: s.counterId,
        during: range(from, to),
        note: s.note.trim() || null,
      };
      const table = supabase.schema('app').from('staff_shifts');
      const { error } = s.id ? await table.update(row).eq('id', s.id) : await table.insert(row);
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'shifts'] }),
  });
}

export function useDeleteShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.schema('app').from('staff_shifts').delete().eq('id', id);
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'shifts'] }),
  });
}

/** Repeats last week's shifts a week later, keeping each shift's wall-clock times across DST. */
export function useCopyWeek(orgId: string, locationId: string, timeZone: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (last: Shift[]) => {
      const rows = last.map((s) => {
        const day = addDays(s.serviceDay, 7);
        const startHm = localTimeValue(s.startsAt, timeZone);
        const endHm = localTimeValue(s.endsAt, timeZone);
        const from = instantOn(day, startHm, timeZone);
        const to = instantOn(endHm > startHm ? day : addDays(day, 1), endHm, timeZone);
        return {
          org_id: orgId,
          location_id: locationId,
          user_id: s.userId,
          counter_id: s.counterId,
          during: range(from, to),
          note: s.note,
        };
      });
      if (rows.length === 0) return;
      const { error } = await supabase.schema('app').from('staff_shifts').insert(rows);
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'shifts'] }),
  });
}

export { addDays };

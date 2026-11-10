import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';
import type { Interval } from '../api.ts';

/** One calendar date's exception: closed all day, or special hours. */
export interface HoursException {
  date: string;
  closed: boolean;
  intervals: Interval[];
  note: string;
}

const key = (locationId: string) => ['admin', 'hours-exceptions', locationId];
const clock = (time: string | null) => (time ?? '').slice(0, 5);

/** Every exception of a location, grouped by date and oldest first, read under RLS. */
export const exceptionsQuery = (locationId: string) =>
  queryOptions({
    queryKey: key(locationId),
    queryFn: async (): Promise<HoursException[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('hours_exceptions')
        .select('date, closed, opens, closes, note')
        .eq('location_id', locationId)
        .order('date')
        .order('opens');
      if (error) throw error;
      const byDate = new Map<string, HoursException>();
      for (const row of data) {
        const day = byDate.get(row.date) ?? {
          date: row.date,
          closed: row.closed,
          intervals: [],
          note: row.note ?? '',
        };
        if (!row.closed) day.intervals.push({ opens: clock(row.opens), closes: clock(row.closes) });
        byDate.set(row.date, day);
      }
      return [...byDate.values()];
    },
  });

/**
 * Adds an exception to each of `dates` in one statement, so all or none are saved. The database
 * refuses a date that already has one (`hours_overlap`).
 */
export function useAddException(locationId: string, orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      dates: string[];
      closed: boolean;
      interval: Interval;
      note: string;
    }) => {
      const rows = input.dates.map((date) => ({
        org_id: orgId,
        location_id: locationId,
        date,
        closed: input.closed,
        opens: input.closed ? null : input.interval.opens,
        closes: input.closed ? null : input.interval.closes,
        note: input.note.trim() || null,
      }));
      const { error } = await supabase.schema('app').from('hours_exceptions').insert(rows);
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(locationId) }),
  });
}

/** Removes every exception row of one date. */
export function useRemoveException(locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (date: string) => {
      const { error } = await supabase
        .schema('app')
        .from('hours_exceptions')
        .delete()
        .eq('location_id', locationId)
        .eq('date', date);
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(locationId) }),
  });
}

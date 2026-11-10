import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface Interval {
  /** `HH:MM`. Closing before opening means the interval ends the next day. */
  opens: string;
  closes: string;
}

/** Intervals per weekday, 0 = Sunday; a day with none is closed. */
export type WeekHours = Interval[][];

/** The database allows this many intervals a day (`hours_too_many`). */
export const MAX_INTERVALS = 3;

export const emptyWeek = (): WeekHours => Array.from({ length: 7 }, () => []);

const hoursKey = (locationId: string) => ['admin', 'hours', locationId];

const clock = (time: string) => time.slice(0, 5);

/** A location's weekly hours, read under RLS. */
export const hoursQuery = (locationId: string) =>
  queryOptions({
    queryKey: hoursKey(locationId),
    queryFn: async (): Promise<WeekHours> => {
      const { data, error } = await supabase
        .schema('app')
        .from('business_hours')
        .select('weekday, opens, closes')
        .eq('location_id', locationId)
        .order('opens');
      if (error) throw error;
      const week = emptyWeek();
      for (const row of data)
        week[row.weekday]?.push({ opens: clock(row.opens), closes: clock(row.closes) });
      return week;
    },
  });

/** A save the database refused: its error code and the weekday it refused. */
export class HoursSaveError extends Error {
  constructor(
    readonly code: string,
    readonly weekday: number | null,
  ) {
    super(code);
  }
}

/**
 * Replaces the location's weekly hours. The database validates every row (overlaps, including a
 * cross-midnight interval spilling into the next day); when it refuses one, the previous hours
 * are put back, so a refused save changes nothing, and the error names the weekday refused.
 * RLS lets only admins and owners write.
 */
export function useSaveHours(locationId: string, orgId: string) {
  const queryClient = useQueryClient();
  const table = () => supabase.schema('app').from('business_hours');
  const insertDay = async (week: WeekHours, weekday: number) => {
    const rows = (week[weekday] ?? []).map((i) => ({
      org_id: orgId,
      location_id: locationId,
      weekday,
      opens: i.opens,
      closes: i.closes,
    }));
    if (rows.length === 0) return;
    const { error } = await table().insert(rows);
    if (error) throw new HoursSaveError(errorCode(error), weekday);
  };
  const clear = async () => {
    const { error } = await table().delete().eq('location_id', locationId);
    if (error) throw new HoursSaveError(errorCode(error), null);
  };
  return useMutation({
    mutationFn: async (week: WeekHours) => {
      const previous = await queryClient.fetchQuery({ ...hoursQuery(locationId), staleTime: 0 });
      await clear();
      try {
        for (let weekday = 0; weekday < 7; weekday++) await insertDay(week, weekday);
      } catch (error) {
        await clear();
        for (let weekday = 0; weekday < 7; weekday++) await insertDay(previous, weekday);
        throw error;
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: hoursKey(locationId) }),
  });
}

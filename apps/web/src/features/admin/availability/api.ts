import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import type { Range } from './overlap.ts';

// Weekly availability and exceptions (A-4), read and written under RLS (staff read, managers write).
// `staffUserId` null means "any staff": the rules that apply to the location as a whole.

export interface Rule extends Range {
  id: string;
  weekday: number;
}

export interface Exception {
  id: string;
  localDate: string;
  kind: 'unavailable' | 'extra';
  /** HH:MM, or null for the whole day. */
  starts: string | null;
  ends: string | null;
  note: string | null;
}

const hhmm = (t: string | null) => (t === null ? null : t.slice(0, 5));
const key = (locationId: string, staff: string | null) => [
  'admin',
  'availability',
  locationId,
  staff,
];

function forStaff<T extends { eq: (c: string, v: string) => T; is: (c: string, v: null) => T }>(
  query: T,
  staff: string | null,
): T {
  return staff === null ? query.is('staff_user_id', null) : query.eq('staff_user_id', staff);
}

export const rulesQuery = (locationId: string, staff: string | null) =>
  queryOptions({
    queryKey: [...key(locationId, staff), 'rules'],
    queryFn: async (): Promise<Rule[]> => {
      const { data, error } = await forStaff(
        supabase
          .schema('app')
          .from('availability_rules')
          .select('id, weekday, starts, ends, valid_from, valid_to')
          .eq('location_id', locationId)
          .is('service_id', null),
        staff,
      )
        .order('weekday')
        .order('starts');
      if (error) throw error;
      return data.map((r) => ({
        id: r.id,
        weekday: r.weekday,
        starts: hhmm(r.starts)!,
        ends: hhmm(r.ends)!,
        validFrom: r.valid_from,
        validTo: r.valid_to,
      }));
    },
  });

export const exceptionsQuery = (locationId: string, staff: string | null) =>
  queryOptions({
    queryKey: [...key(locationId, staff), 'exceptions'],
    queryFn: async (): Promise<Exception[]> => {
      const { data, error } = await forStaff(
        supabase
          .schema('app')
          .from('availability_exceptions')
          .select('id, local_date, kind, starts, ends, note')
          .eq('location_id', locationId),
        staff,
      ).order('local_date');
      if (error) throw error;
      return data.map((x) => ({
        id: x.id,
        localDate: x.local_date,
        kind: x.kind,
        starts: hhmm(x.starts),
        ends: hhmm(x.ends),
        note: x.note,
      }));
    },
  });

interface Target {
  orgId: string;
  locationId: string;
  staff: string | null;
}

type Change =
  | { table: 'rule'; kind: 'add'; weekday: number; range: Range }
  | { table: 'exception'; kind: 'add'; value: Omit<Exception, 'id'> }
  | { table: 'rule' | 'exception'; kind: 'remove'; id: string };

/** Adds or removes a weekly range or an exception, then refreshes both lists and the slot previews they change. */
export function useChangeAvailability(target: Target) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: Change) => {
      const base = {
        org_id: target.orgId,
        location_id: target.locationId,
        staff_user_id: target.staff,
      };
      const rules = supabase.schema('app').from('availability_rules');
      const exceptions = supabase.schema('app').from('availability_exceptions');
      const { error } =
        change.kind === 'remove'
          ? await (change.table === 'rule' ? rules : exceptions).delete().eq('id', change.id)
          : change.table === 'rule'
            ? await rules.insert({
                ...base,
                weekday: change.weekday,
                starts: change.range.starts,
                ends: change.range.ends,
                valid_from: change.range.validFrom,
                valid_to: change.range.validTo,
              })
            : await exceptions.insert({
                ...base,
                local_date: change.value.localDate,
                kind: change.value.kind,
                starts: change.value.starts,
                ends: change.value.ends,
                note: change.value.note,
              });
      if (error) throw new Error(error.code === '42501' ? 'permission_denied' : error.message);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key(target.locationId, target.staff) });
      await queryClient.invalidateQueries({ queryKey: ['booking', 'slots'] });
    },
  });
}

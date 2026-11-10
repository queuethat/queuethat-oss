import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export const RESOURCE_KINDS = ['counter', 'desk', 'room', 'table', 'chair', 'staff'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** What an admin edits on a resource (2A-Q3): a seat, room or person guests are sent to. */
export interface ResourceSettings {
  label: string;
  kind: ResourceKind;
  /** Tables only. */
  seats: number | null;
  /** Staff only: the member this resource is. */
  memberUserId: string | null;
}

/** A place guests are sent when called: "A012 → Chair 2" (A7, #47). */
export interface CounterRow extends ResourceSettings {
  id: string;
}

export const NEW_RESOURCE: ResourceSettings = {
  label: '',
  kind: 'counter',
  seats: null,
  memberUserId: null,
};

const countersKey = (locationId: string) => ['admin', 'counters', locationId];

/** A location's counters that are not archived, read under RLS. */
export const countersQuery = (locationId: string) =>
  queryOptions({
    queryKey: countersKey(locationId),
    queryFn: async (): Promise<CounterRow[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('counters')
        .select('id, label, kind, seats, member_user_id')
        .eq('location_id', locationId)
        .is('archived_at', null)
        .order('sort_order')
        // Ties keep the order the counters were added in.
        .order('created_at')
        .order('label');
      if (error) throw error;
      return data.map((c) => ({
        id: c.id,
        label: c.label,
        kind: c.kind,
        seats: c.seats,
        memberUserId: c.member_user_id,
      }));
    },
  });

const columns = (r: ResourceSettings) => ({
  label: r.label.trim(),
  kind: r.kind,
  seats: r.kind === 'table' ? r.seats : null,
  member_user_id: r.kind === 'staff' ? r.memberUserId : null,
});

type Change =
  | { kind: 'create'; settings: ResourceSettings }
  | { kind: 'update'; id: string; settings: ResourceSettings }
  | { kind: 'archive'; id: string };

/**
 * Creates, edits or archives a resource (counter, desk, room, table, chair or staff member) under RLS (managers and up, `counters_*` policies).
 * Archiving keeps the row, so past calls still name their counter. A row RLS hides fails as
 * `permission_denied`.
 */
export function useChangeCounter(location: { orgId: string; locationId: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: Change) => {
      const counters = supabase.schema('app').from('counters');
      const last =
        change.kind === 'create'
          ? await counters
              .select('sort_order')
              .eq('location_id', location.locationId)
              .order('sort_order', { ascending: false })
              .limit(1)
          : null;
      if (last?.error) throw new Error(errorCode(last.error));
      const { data, error } =
        change.kind === 'create'
          ? await counters
              .insert({
                org_id: location.orgId,
                location_id: location.locationId,
                ...columns(change.settings),
                // After every counter so far, archived ones too, so a new counter is listed last.
                sort_order: (last?.data?.[0]?.sort_order ?? 0) + 1,
              })
              .select('id')
          : await counters
              .update(
                change.kind === 'update'
                  ? columns(change.settings)
                  : { archived_at: new Date().toISOString() },
              )
              .eq('id', change.id)
              .select('id');
      if (error) throw new Error(errorCode(error));
      if (data.length === 0) throw new Error('permission_denied');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: countersKey(location.locationId) }),
  });
}

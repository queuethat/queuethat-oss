import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from '../../../lib/live.ts';
import { supabase } from '../../../lib/supabase.ts';

export type PresenceStatus = 'available' | 'break' | 'away';

export interface TeamPresence {
  userId: string;
  status: PresenceStatus;
  counterId: string | null;
  /** When the status last changed (ISO); the break timer counts from it. */
  since: string;
}

/** The database ignores presence older than this (it counts as away); the strip does not show it. */
const FRESH_MS = 12 * 60 * 60_000;

/**
 * Who has reported presence at the location, live on the location topic (`api.set_my_presence`
 * bumps it). The ETA rule itself stays in the database.
 */
export function useTeamPresence(locationId: string | undefined) {
  return useLiveQuery({
    topic: locationId ? `loc:${locationId}` : null,
    queryKey: ['console', 'presence', locationId],
    enabled: !!locationId,
    queryFn: async (): Promise<TeamPresence[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('staff_presence')
        .select('user_id, status, counter_id, since')
        .eq('location_id', locationId!)
        .gte('updated_at', new Date(Date.now() - FRESH_MS).toISOString())
        .order('since');
      if (error) throw error;
      return data.map((r) => ({
        userId: r.user_id,
        status: r.status as PresenceStatus,
        counterId: r.counter_id,
        since: r.since,
      }));
    },
  });
}

/** Sets the caller's own status at the location, optionally at a counter. */
export function useSetPresence(locationId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      status,
      counterId,
    }: {
      status: PresenceStatus;
      counterId: string | null;
    }) => {
      const { error } = await supabase.rpc('set_my_presence', {
        p_location_id: locationId!,
        p_status: status,
        // The generated types say string; null means no particular counter.
        p_counter_id: counterId as string,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['console', 'presence'] }),
  });
}

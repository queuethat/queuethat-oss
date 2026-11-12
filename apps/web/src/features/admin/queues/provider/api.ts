import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';

/** A line's kind and, for a provider line, whose it is (#1388). */
export interface LineOwner {
  kind: 'general' | 'provider' | 'pool';
  providerUserId: string | null;
}

const key = (locationId: string) => ['admin', 'queues', locationId, 'providers'] as const;

/** Every open line at the location with its kind and person, by queue id. */
export const lineOwnersQuery = (locationId: string) =>
  queryOptions({
    queryKey: key(locationId),
    queryFn: async (): Promise<Record<string, LineOwner>> => {
      const { data, error } = await supabase
        .schema('app')
        .from('queues')
        .select('id, kind, provider_user_id')
        .eq('location_id', locationId)
        .is('archived_at', null);
      if (error) throw new Error(errorCode(error));
      return Object.fromEntries(
        data.map((q) => [
          q.id,
          { kind: q.kind as LineOwner['kind'], providerUserId: q.provider_user_id },
        ]),
      );
    },
  });

/**
 * Names the person whose line it is (null = anyone). Naming someone makes a general line a provider
 * line; clearing the person keeps the kind, so a pool a provider line pulls from keeps working.
 * Managers and up (queues_update policy); the database checks the person works at the location.
 */
export function useSetLineOwner(locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { queueId: string; userId: string | null }) => {
      const patch = input.userId
        ? { kind: 'provider', provider_user_id: input.userId }
        : { provider_user_id: null };
      const { data, error } = await supabase
        .schema('app')
        .from('queues')
        .update(patch)
        .eq('id', input.queueId)
        .select('id');
      if (error) throw new Error(errorCode(error));
      if (data.length === 0) throw new Error('permission_denied');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(locationId) }),
  });
}

import { errorCode } from '@qm/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { selectLocation } from '../../auth/current.ts';
import { asPlanLimitError } from '../billing/planLimit.tsx';

/** What the admin types to add a location. A blank slug lets the database derive it from the name. */
export interface NewLocation {
  orgId: string;
  name: string;
  timeZone: string;
  slug: string;
}

/**
 * Adds a location to the org (api.create_location). The database owns slug derivation, the free
 * plan's location limit (`plan_limit_reached`) and the Stripe quantity sync, so this only calls it.
 * On success the new location becomes the current one and the location and billing lists refetch.
 */
export function useAddLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewLocation) => {
      const { data, error } = await supabase.rpc('create_location', {
        p_org_id: input.orgId,
        p_name: input.name,
        p_tz: input.timeZone,
        p_slug: input.slug.trim() || undefined,
      });
      if (error) throw asPlanLimitError(error) ?? new Error(errorCode(error));
      return { locationId: data.location_id!, slug: data.slug! };
    },
    onSuccess: async ({ locationId }) => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'locations'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'billing'] });
      selectLocation(locationId);
    },
  });
}

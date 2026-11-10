import { errorCode } from '@qm/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { selectLocation } from '../../auth/current.ts';

/** What the admin types to add a location. A blank slug lets the database derive it from the name. */
export interface NewLocation {
  orgId: string;
  name: string;
  timeZone: string;
  slug: string;
}

/**
 * Adds a location to the org (api.create_location). The database owns slug derivation, so this
 * only calls it. On success the new location becomes the current one and the list refetches.
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
      if (error) throw new Error(errorCode(error));
      return { locationId: data.location_id!, slug: data.slug! };
    },
    onSuccess: async ({ locationId }) => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'locations'] });
      selectLocation(locationId);
    },
  });
}

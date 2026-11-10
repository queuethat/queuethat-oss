import { queryOptions, useMutation, useQuery } from '@tanstack/react-query';
import { supabase } from '../../../../lib/supabase.ts';
import { useSession } from '../../../auth/api.ts';
import { useCurrentLocation, useCurrentOrg } from '../../../auth/current.ts';

// DS-15 (#1019): what the Today checklist shows. The facts come from api.org_setup_state (the
// database decides what "set up" means); the two things it cannot know, "printed the poster"
// and "hid the checklist", are kept per member in their auth profile.

export const setupStateQuery = (orgId: string, locationId: string) =>
  queryOptions({
    queryKey: ['admin', 'setup-state', orgId, locationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('org_setup_state', {
        p_org_id: orgId,
        p_location_id: locationId,
      });
      if (error) throw error;
      return data;
    },
    // Owners come back from other pages having just finished a step.
    staleTime: 0,
    retry: false,
  });

/** The setup facts for a location. Errors for staff (managers and above only): hide the checklist. */
export function useSetupState(orgId: string | undefined, locationId: string | undefined) {
  return useQuery({
    ...setupStateQuery(orgId ?? '', locationId ?? ''),
    enabled: !!orgId && !!locationId,
  });
}

/** What the member did by hand at one location. */
export interface SetupProgress {
  posterPrinted?: boolean;
  dismissed?: boolean;
}

type AllProgress = Record<string, SetupProgress>;

const KEY = 'setup_checklist';

/** The signed-in member's manual progress at `locationId`, and a way to change it. */
export function useSetupProgress(locationId: string | undefined) {
  const session = useSession().data;
  const all = (session?.user.user_metadata[KEY] ?? {}) as AllProgress;
  const progress: SetupProgress = (locationId ? all[locationId] : undefined) ?? {};
  const update = useMutation({
    mutationFn: async (patch: SetupProgress) => {
      if (!locationId) return;
      const next: AllProgress = { ...all, [locationId]: { ...progress, ...patch } };
      const { error } = await supabase.auth.updateUser({ data: { [KEY]: next } });
      if (error) throw error;
    },
  });
  return { progress, update: update.mutate, saving: update.isPending };
}

/**
 * True while the current location has never had a visit, for screens that fill in later (guests,
 * analytics, feedback). False while loading and for roles that cannot read the setup facts, so
 * those screens keep their ordinary wording.
 */
export function useNoVisitsYet(): boolean {
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  return useSetupState(org?.id, location?.id).data?.has_visit === false;
}

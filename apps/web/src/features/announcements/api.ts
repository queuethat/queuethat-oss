import { queryOptions, useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.ts';

/** How often staff pages look for new or ended announcements. */
export const ANNOUNCEMENT_POLL_MS = 60_000;

/**
 * Platform announcements active now (PLT9, #415), most severe first. The read policy decides
 * what "active" means, so this returns exactly what the banner shows.
 */
export const activeAnnouncementsQuery = queryOptions({
  queryKey: ['announcements', 'active'],
  queryFn: async () => {
    const { data, error } = await supabase
      .schema('app')
      .from('platform_announcements')
      .select('id, severity, message')
      .order('severity', { ascending: false })
      .order('starts_at', { ascending: false });
    if (error) throw error;
    return data;
  },
  refetchInterval: ANNOUNCEMENT_POLL_MS,
});

/** Active announcements. Signed-in users only: anon has no access to the table. */
export function useActiveAnnouncements() {
  return useQuery(activeAnnouncementsQuery);
}

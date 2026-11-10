import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

// The signed-in member's calendar feeds (A-16). The database never returns a token after
// creation: only the sha256 is stored, so the list can show nothing but a masked hint.

export interface CalendarFeed {
  id: string;
  includeGuestNames: boolean;
  createdAt: string;
  lastAccessedAt: string | null;
}

const feedsKey = ['account', 'calendar-feeds'];

export function useCalendarFeeds() {
  return useQuery({
    queryKey: feedsKey,
    queryFn: async (): Promise<CalendarFeed[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('calendar_feeds')
        .select('id, include_guest_names, created_at, last_accessed_at')
        .is('revoked_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data.map((f) => ({
        id: f.id,
        includeGuestNames: f.include_guest_names,
        createdAt: f.created_at,
        lastAccessedAt: f.last_accessed_at,
      }));
    },
  });
}

/** Creates a feed; the token in the answer is the only time it is ever available. */
export function useCreateCalendarFeed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (includeGuestNames: boolean) => {
      const { data, error } = await supabase.rpc('create_calendar_feed', {
        p_include_guest_names: includeGuestNames,
      });
      if (error) throw error;
      return data as unknown as { feed_id: string; token: string };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feedsKey }),
  });
}

export function useRevokeCalendarFeed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (feedId: string) => {
      const { error } = await supabase.rpc('revoke_calendar_feed', { p_feed_id: feedId });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feedsKey }),
  });
}

/** `https://<project>/functions/v1/ics-feed/<token>.ics` and its `webcal://` twin for one-tap subscribe. */
export function feedUrls(token: string): { https: string; webcal: string } {
  const base = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ics-feed/${token}.ics`;
  return { https: base, webcal: base.replace(/^https?:/, 'webcal:') };
}

import { useMutation, useQuery } from '@tanstack/react-query';
import { useLiveQuery } from '../../lib/live.ts';
import { supabase } from '../../lib/supabase.ts';

// 2A-KSK1 (#119): the kiosk's reads and its one write. One hook per RPC or table read
// (apps/web/README.md).

/** How often the kiosk asks again whether its queues are open, in case a signal is lost. */
export const KIOSK_POLL_MS = 4_000;

/** The slug of the paired location, which `get_location_public` is keyed by. Paired devices may read their location (RLS). */
export function useLocationSlug(locationId: string | undefined) {
  return useQuery({
    queryKey: ['kiosk', 'slug', locationId],
    enabled: !!locationId,
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('locations')
        .select('slug')
        .eq('id', locationId!)
        .single();
      if (error) throw error;
      return data.slug;
    },
  });
}

/**
 * The location and its queues as the database reports them, kept live by the location's private
 * topic and a short poll: a queue closed by staff shows as closed here within a few seconds.
 */
export function useKioskLocation(locationId: string | undefined, slug: string | undefined) {
  return useLiveQuery({
    topic: locationId ? `loc:${locationId}` : null,
    queryKey: ['kiosk', 'location', slug],
    enabled: !!slug,
    jitterMs: 0,
    pollMs: () => KIOSK_POLL_MS,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_location_public', {
        p_location_slug: slug!,
      });
      if (error) throw error;
      return data;
    },
  });
}

export interface KioskJoinInput {
  queueId: string;
  serviceId: string | null;
  name: string;
  phoneE164: string | null;
  partySize: number;
  locale: string;
  /** One per check-in, so a double tap or a retry lands on the same ticket. */
  key: string;
}

/**
 * Checks a guest in with `join_queue` as the paired kiosk device: no CAPTCHA, and the database
 * refuses (`not_found`) a queue outside the device's location. The result is not kept after the
 * screen resets (`gcTime: 0`), so the next guest never finds the previous ticket in memory.
 */
export function useKioskJoin() {
  return useMutation({
    gcTime: 0,
    mutationFn: async (input: KioskJoinInput) => {
      const { data, error } = await supabase.rpc('join_queue', {
        p_queue_id: input.queueId,
        // Generated types say string; the function takes null for "no service" / "no phone".
        p_service_id: input.serviceId as string,
        p_name: input.name,
        p_phone_e164: input.phoneE164 as string,
        p_email: null as unknown as string,
        p_party_size: input.partySize,
        p_locale: input.locale,
        p_idempotency_key: input.key,
      });
      if (error) throw error;
      return data;
    },
  });
}

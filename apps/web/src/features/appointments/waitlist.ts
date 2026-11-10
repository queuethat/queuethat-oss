import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase.ts';
import { parseRange } from '../admin/events/time.ts';

/** A guest waiting for (or holding an offer of) a slot on a day. */
export interface WaitlistRow {
  id: string;
  serviceId: string;
  name: string;
  status: 'waiting' | 'offered';
  window: { start: string; end: string } | null;
  offerExpiresAt: string | null;
}

/** Open waitlist entries of a location for a local day, oldest first (staff of the location). */
export function useDayWaitlist(locationId: string | undefined, day: string) {
  return useQuery({
    enabled: !!locationId,
    queryKey: ['appointments', 'waitlist', locationId, day],
    refetchInterval: 15_000,
    queryFn: async (): Promise<WaitlistRow[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('slot_waitlist')
        .select('id, service_id, name, during, status, offer_expires_at')
        .eq('location_id', locationId!)
        .eq('wanted_day', day)
        .in('status', ['waiting', 'offered'])
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data.map((r) => ({
        id: r.id,
        serviceId: r.service_id,
        name: r.name,
        status: r.status as WaitlistRow['status'],
        window: r.during ? parseRange(String(r.during)) : null,
        offerExpiresAt: r.offer_expires_at,
      }));
    },
  });
}

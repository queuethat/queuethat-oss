import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** api.appointment_search_row */
export interface SearchHit {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  guest_name: string | null;
  service_name: string | null;
  staff_name: string | null;
}

/** Appointments of a location matching a name, phone ending, email or reference over a local date range. */
export function useAppointmentSearch(
  locationId: string | undefined,
  query: string,
  range: { from: string; to: string },
  status: string,
) {
  return useQuery({
    enabled: !!locationId && query.length >= 2,
    queryKey: ['appointments', 'search', locationId, query, range.from, range.to, status],
    queryFn: async (): Promise<SearchHit[]> => {
      const { data, error } = await supabase.rpc('search_appointments', {
        p_location_id: locationId!,
        p_query: query,
        p_from: range.from,
        p_to: range.to,
        p_statuses: (status ? [status] : null) as unknown as string[],
        p_limit: 25,
      });
      if (error) throw error;
      return data as unknown as SearchHit[];
    },
  });
}

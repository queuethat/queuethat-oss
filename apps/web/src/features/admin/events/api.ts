import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { uuid } from '../../guest/api.ts';
import { formatRange, parseRange } from './time.ts';

// Admin access to events (A-10): one hook per RPC or table read (apps/web/README.md).

export interface EventRow {
  id: string;
  title: string;
  serviceId: string;
  start: string;
  end: string;
  capacity: number;
  booked: number;
  status: 'scheduled' | 'cancelled';
  public: boolean;
}

export interface Attendee {
  id: string;
  guest_name: string;
  seats: number;
  status: string;
}

export interface EventInput {
  id?: string;
  locationId: string;
  orgId: string;
  serviceId: string;
  title: string;
  start: string;
  end: string;
  capacity: number;
  public: boolean;
}

/** The location's events, soonest first. */
export function useEvents(locationId: string | undefined) {
  return useQuery({
    enabled: !!locationId,
    queryKey: ['events', 'list', locationId],
    queryFn: async (): Promise<EventRow[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('events')
        .select('id, title, service_id, during, capacity, booked, status, public')
        .eq('location_id', locationId!)
        .order('during', { ascending: true });
      if (error) throw error;
      return data.map((e) => ({
        id: e.id,
        title: e.title,
        serviceId: e.service_id,
        ...parseRange(String(e.during)),
        capacity: e.capacity,
        booked: e.booked,
        status: e.status as EventRow['status'],
        public: e.public,
      }));
    },
  });
}

/** Who holds seats in an event (cancelled bookings included, marked by status). */
export function useEventAttendees(eventId: string | null) {
  return useQuery({
    enabled: !!eventId,
    queryKey: ['events', 'attendees', eventId],
    queryFn: async (): Promise<Attendee[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('appointments')
        .select('id, guest_name, seats, status')
        .eq('event_id', eventId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data as Attendee[];
    },
  });
}

/** Creates or edits an event (managers; the database refuses moving one that has bookings). */
export function useSaveEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: EventInput) => {
      const row = {
        service_id: input.serviceId,
        title: input.title,
        during: formatRange(input.start, input.end),
        capacity: input.capacity,
        public: input.public,
      };
      const table = supabase.schema('app').from('events');
      const { error } = input.id
        ? await table.update(row).eq('id', input.id)
        : await table.insert({ ...row, org_id: input.orgId, location_id: input.locationId });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['events'] }),
  });
}

export function useCancelEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { eventId: string; reason: string }) => {
      const { error } = await supabase.rpc('cancel_event', {
        p_event_id: input.eventId,
        p_reason: input.reason,
        p_idempotency_key: uuid(),
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['events'] }),
  });
}

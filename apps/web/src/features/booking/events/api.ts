import { errorCode } from '@qm/domain';
import { useMutation, useQuery } from '@tanstack/react-query';
import { guestRpc } from '../../guest/client.ts';
import { attemptKey, store, type BookingResult } from '../api.ts';

// The booking page's events tab: one hook per RPC (apps/web/README.md).

/** api.event_row */
export interface PublicEvent {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  seats_taken: number;
  status: string;
}

/** Upcoming public events of a location by its poster slug. */
export function useLocationEvents(slug: string) {
  return useQuery({
    queryKey: ['booking', 'events', slug],
    queryFn: async () =>
      (await guestRpc('get_location_events', {
        p_location_slug: slug,
      })) as unknown as PublicEvent[],
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
  });
}

export interface BookSeatsInput {
  eventId: string;
  name: string;
  phoneE164: string | null;
  email: string | null;
  seats: number;
}

/** Books seats. Like slot booking, the key lives in localStorage until it succeeds, so a retry is one booking. */
export function useBookEventSeats() {
  return useMutation({
    mutationFn: async (input: BookSeatsInput): Promise<BookingResult> => {
      const keyName = `qm:event-key:${input.eventId}:${input.seats}`;
      const result = (await guestRpc('book_event_seats', {
        p_event_id: input.eventId,
        p_name: input.name,
        p_phone_e164: input.phoneE164,
        p_email: input.email,
        p_party_size: input.seats,
        p_idempotency_key: attemptKey(keyName),
      })) as unknown as BookingResult;
      store(keyName, null);
      return result;
    },
  });
}

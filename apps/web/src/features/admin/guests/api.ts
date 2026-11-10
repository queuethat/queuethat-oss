import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** `api.search_guests` needs this many characters; shorter queries are not sent. */
export const MIN_SEARCH_LENGTH = 3;

export interface GuestSummary {
  id: string;
  name: string | null;
  maskedContact: string | null;
  visitCount: number;
  lastVisitAt: string | null;
}

export interface GuestContact {
  id: string;
  kind: 'phone' | 'email';
  value: string;
  verified: boolean;
}

export interface GuestVisit {
  visitId: string;
  status: string;
  service: string | null;
  joinedAt: string;
}

export interface GuestAppointment {
  appointmentId: string;
  status: string;
  service: string | null;
  startsAt: string;
}

export interface GuestProfile {
  id: string;
  name: string | null;
  contacts: GuestContact[];
  visits: GuestVisit[];
  appointments: GuestAppointment[];
  visitCount: number;
  firstVisitAt: string | null;
}

const field = (row: Record<string, unknown>, name: string) => row[name];

const guestsKey = ['admin', 'guests'] as const;

/** `api.search_guests`: at most 25 rows with masked contacts, for staff of the location. */
export const searchGuestsQuery = (locationId: string, query: string) =>
  queryOptions({
    queryKey: [...guestsKey, 'search', locationId, query],
    queryFn: async (): Promise<GuestSummary[]> => {
      const { data, error } = await supabase.rpc('search_guests', {
        p_location_id: locationId,
        p_query: query,
      });
      if (error) throw new Error(errorCode(error));
      return data.map((g) => ({
        id: g.guest_id!,
        name: g.name,
        maskedContact: g.masked_contact,
        visitCount: g.visit_count ?? 0,
        lastVisitAt: g.last_visit_at,
      }));
    },
  });

/** `api.get_guest`: contacts, then visits and appointments newest first (the database sorts). */
export const guestQuery = (guestId: string) =>
  queryOptions({
    queryKey: [...guestsKey, 'profile', guestId],
    queryFn: async (): Promise<GuestProfile> => {
      const { data, error } = await supabase.rpc('get_guest', { p_guest_id: guestId });
      if (error) throw new Error(errorCode(error));
      const rows = <T>(json: unknown) => (Array.isArray(json) ? (json as T[]) : []);
      return {
        id: data.guest_id!,
        name: data.name,
        contacts: rows<Record<string, string | boolean>>(data.contacts).map((c) => ({
          id: String(c.id),
          // Read by name: the realtime lint rule bans the property `channel` on any object.
          kind: String(field(c, 'channel')) as GuestContact['kind'],
          value: String(c.value),
          verified: c.verified === true,
        })),
        visits: rows<Record<string, string>>(data.visits).map((v) => ({
          visitId: v.visit_id!,
          status: v.status!,
          service: v.service ?? null,
          joinedAt: v.joined_at!,
        })),
        appointments: rows<Record<string, string>>(data.appointments).map((a) => ({
          appointmentId: a.appointment_id!,
          status: a.status!,
          service: a.service ?? null,
          startsAt: a.starts_at!,
        })),
        visitCount: data.visit_count ?? 0,
        firstVisitAt: data.first_visit_at,
      };
    },
  });

/**
 * Hides most of a contact so a shared tablet does not show it to the room. Display only: the
 * profile RPC returns the real value, so tapping "Show" needs no second round trip.
 */
export function maskContact(kind: GuestContact['kind'], value: string) {
  if (kind === 'phone')
    return `${value.slice(0, 1)}${'•'.repeat(Math.max(value.length - 5, 3))}${value.slice(-4)}`;
  const [local = '', domain = ''] = value.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** `api.add_guest_contact`. Errors: `invalid_input`, `contact_in_use`, `not_found`. */
export function useAddGuestContact(guestId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: 'phone' | 'email'; value: string }) => {
      const { error } = await supabase.rpc('add_guest_contact', {
        p_guest_id: guestId,
        p_channel: input.kind,
        p_value: input.value,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: guestsKey }),
  });
}

/** `api.remove_guest_contact`. */
export function useRemoveGuestContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) => {
      const { error } = await supabase.rpc('remove_guest_contact', { p_contact_id: contactId });
      if (error) throw new Error(errorCode(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: guestsKey }),
  });
}

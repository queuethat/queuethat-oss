import { errorCode } from '@qm/domain';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { joinPass, uuid } from '../guest/api.ts';
import { guestRpc } from '../guest/client.ts';
import { addDays, localDate, type Slot } from './slots.ts';

// Booking data access: one query-options factory and one hook per RPC (apps/web/README.md).

/** api.booking_result */
export interface BookingResult {
  token: string;
  starts_at: string;
  ends_at: string;
  service_name: string;
  location_name: string;
  status: string;
}

/**
 * api.appointment_status. @qm/db-types resolves this composite to the same-named app enum, so
 * the shape is spelled out here until the generator tells them apart.
 */
export interface AppointmentStatus {
  starts_at: string;
  ends_at: string;
  status: 'booked' | 'cancelled' | 'completed' | 'no_show' | string;
  service_name: string;
  location_name: string;
  location_slug: string;
  can_reschedule: boolean;
  can_cancel: boolean;
  as_of: string;
}

/** The location's name, timezone and services (every queue's, once each) by its poster slug. */
export function useBookingLocation(slug: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['booking', 'location', slug],
    queryFn: async () => {
      const location = await guestRpc('get_location_public', { p_location_slug: slug });
      const services = new Map<string, { name: string; queueId: string | null }>();
      for (const queue of location.queues ?? [])
        for (const s of queue.services ?? [])
          if (s.id && !services.has(s.id))
            services.set(s.id, { name: s.name ?? '', queueId: queue.id ?? null });
      return {
        name: location.name ?? '',
        tz: location.tz ?? 'UTC',
        countryCode: location.country_code,
        retentionDays: location.retention_days,
        captchaSiteKey: location.captcha_site_key ?? null,
        services: [...services].map(([id, s]) => ({ id, ...s })),
      };
    },
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
  });
}

/** get_available_slots allows a window of 31 days. */
const WINDOW_DAYS = 30;

export function slotsQuery(slug: string, serviceId: string, tz: string) {
  return {
    queryKey: ['booking', 'slots', slug, serviceId],
    queryFn: async (): Promise<Slot[]> => {
      const from = localDate(new Date(), tz);
      return (await guestRpc('get_available_slots', {
        p_location_slug: slug,
        p_service_id: serviceId,
        p_from: from,
        p_to: addDays(from, WINDOW_DAYS),
      })) as Slot[];
    },
    retry: (count: number, error: unknown) => errorCode(error) !== 'not_found' && count < 2,
  };
}

/**
 * Open slots of each listed service for the next 30 days. Services that are not bookable
 * answer with no slots, which is how the page knows to leave them out.
 */
export function useServiceSlots(slug: string, serviceIds: string[], tz: string) {
  const results = useQueries({ queries: serviceIds.map((id) => slotsQuery(slug, id, tz)) });
  const queryClient = useQueryClient();
  return {
    isPending: results.some((r) => r.isPending),
    isError: results.length > 0 && results.every((r) => r.isError),
    slots: Object.fromEntries(serviceIds.map((id, i) => [id, results[i]?.data ?? []])) as Record<
      string,
      Slot[]
    >,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['booking', 'slots', slug] }),
  };
}

export interface BookInput {
  slug: string;
  serviceId: string;
  slotStart: string;
  name: string;
  phoneE164: string | null;
  email: string | null;
  locale: string;
  /** Turnstile token, when the deployment asks for one (the booking page's `captchaSiteKey`). */
  captchaToken?: string | null;
}

/**
 * Books a slot. The idempotency key lives in localStorage per slot until the booking succeeds,
 * so a double tap, a retry after a lost answer or a reload all return the same appointment.
 */
export function useBook() {
  return useMutation({
    mutationFn: async (input: BookInput): Promise<BookingResult> => {
      const keyName = `qm:book-key:${input.slug}:${input.serviceId}:${input.slotStart}`;
      const result = (await guestRpc('book_appointment', {
        p_location_slug: input.slug,
        p_service_id: input.serviceId,
        p_slot_start: input.slotStart,
        p_name: input.name,
        p_phone_e164: input.phoneE164,
        p_email: input.email,
        p_party_size: 1,
        p_locale: input.locale,
        p_idempotency_key: attemptKey(keyName),
        p_join_pass: input.captchaToken ? await joinPass(input.captchaToken) : null,
      })) as BookingResult;
      store(keyName, null);
      return result;
    },
  });
}

/** The appointment behind a link token; unknown and expired tokens are both not_found. */
export function useAppointment(token: string) {
  return useQuery({
    queryKey: ['booking', 'appointment', token],
    queryFn: async () =>
      (await guestRpc('get_appointment', { p_token: token })) as unknown as AppointmentStatus,
    retry: (count, error) => errorCode(error) !== 'not_found' && count < 2,
    // The card is confirmed by the provider's webhook, a moment after the guest's own confirmation.
    refetchInterval: (q) => (q.state.data?.status === 'pending_payment' ? 4_000 : false),
  });
}

export function useCancelAppointment(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await guestRpc('guest_cancel_appointment', {
        p_token: token,
        p_idempotency_key: uuid(),
      })) as unknown as AppointmentStatus,
    onSuccess: (data) => queryClient.setQueryData(['booking', 'appointment', token], data),
  });
}

export function useRescheduleAppointment(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newSlotStart: string) =>
      (await guestRpc('guest_reschedule_appointment', {
        p_token: token,
        p_new_slot_start: newSlotStart,
        p_idempotency_key: uuid(),
      })) as unknown as AppointmentStatus,
    onSuccess: (data) => queryClient.setQueryData(['booking', 'appointment', token], data),
  });
}

/** The idempotency key of one attempt, kept in localStorage until the attempt succeeds (see {@link store}). */
export function attemptKey(name: string): string {
  const existing = read(name);
  if (existing) return existing;
  const fresh = uuid();
  store(name, fresh);
  return fresh;
}

// Storage can throw (private mode); booking must still work, just without protection across reloads.
function read(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

export function store(name: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch {
    // ignored, see read()
  }
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from '../../lib/live.ts';
import { supabase } from '../../lib/supabase.ts';
import { uuid } from '../guest/api.ts';

// Staff access to appointments: one hook per RPC or table read (apps/web/README.md).

/** api.appointment_row */
export interface AppointmentRow {
  id: string;
  location_id: string;
  service_id: string;
  staff_user_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  guest_name: string | null;
  visit_id: string | null;
  version: number;
}

/** How often the agenda polls: front desks should see a guest's own change within seconds. */
const AGENDA_POLL_MS = 5_000;

/** Appointments of a location for a local date range (inclusive), kept current by polling. */
export function useAppointments(locationId: string | undefined, from: string, to: string) {
  return useLiveQuery({
    topic: null,
    pollMs: () => AGENDA_POLL_MS,
    enabled: !!locationId,
    queryKey: ['appointments', 'list', locationId, from, to],
    queryFn: async (): Promise<AppointmentRow[]> => {
      const { data, error } = await supabase.rpc('list_appointments', {
        p_location_id: locationId!,
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return data as unknown as AppointmentRow[];
    },
  });
}

/** The location's active services, by name, for filters and the booking dialog. */
export function useLocationServices(locationId: string | undefined) {
  return useQuery({
    enabled: !!locationId,
    queryKey: ['appointments', 'services', locationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('services')
        .select('id, name')
        .eq('location_id', locationId!)
        .eq('active', true)
        .order('name');
      if (error) throw error;
      return data;
    },
  });
}

export interface StaffBookInput {
  locationId: string;
  serviceId: string;
  slotStart: string;
  name: string;
  phoneE164: string | null;
  email: string | null;
  overrideCapacity: boolean;
}

/** Books for a caller. A repeat of the same dialog submit is one booking: the key is made per call site. */
export function useStaffBook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StaffBookInput & { key: string }) => {
      const { data, error } = await supabase.rpc('staff_book_appointment', {
        p_location_id: input.locationId,
        p_service_id: input.serviceId,
        p_slot_start: input.slotStart,
        p_staff_user_id: null as unknown as string,
        p_name: input.name,
        p_phone_e164: input.phoneE164 as unknown as string,
        p_email: input.email as unknown as string,
        p_party_size: 1,
        p_override_capacity: input.overrideCapacity,
        p_idempotency_key: input.key,
      });
      if (error) throw error;
      return data as unknown as AppointmentRow;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  });
}

export function useStaffCancel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { appointment: AppointmentRow; reason: string }) => {
      const { data, error } = await supabase.rpc('staff_cancel_appointment', {
        p_appointment_id: input.appointment.id,
        p_expected_version: input.appointment.version,
        p_reason: input.reason,
        p_idempotency_key: uuid(),
      });
      if (error) throw error;
      return data as unknown as AppointmentRow;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  });
}

/** api.appointment_series_result */
export interface SeriesResult {
  series_id: string | null;
  booked: string[];
  conflicts: { date: string; code: string }[];
}

export interface SeriesInput extends Omit<StaffBookInput, 'slotStart' | 'overrideCapacity'> {
  /** The location-local date and wall-clock time of the first occurrence. */
  firstDate: string;
  localTime: string;
  intervalWeeks: number;
  count: number | null;
  until: string | null;
}

/**
 * Books a series, or with `dryRun` only reports which dates would book and which conflict. The key
 * is shared by the preview and the confirm: a preview keeps nothing, so confirming still books.
 */
export function useCreateSeries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SeriesInput & { key: string; dryRun: boolean }) => {
      const { data, error } = await supabase.rpc('create_appointment_series', {
        p_location_id: input.locationId,
        p_service_id: input.serviceId,
        p_first_date: input.firstDate,
        p_local_time: input.localTime,
        p_interval_weeks: input.intervalWeeks,
        p_count: input.count as unknown as number,
        p_until: input.until as unknown as string,
        p_staff_user_id: null as unknown as string,
        p_name: input.name,
        p_phone_e164: input.phoneE164 as unknown as string,
        p_email: input.email as unknown as string,
        p_idempotency_key: input.key,
        p_dry_run: input.dryRun,
      });
      if (error) throw error;
      return data as unknown as SeriesResult;
    },
    onSuccess: (_data, input) =>
      input.dryRun ? undefined : queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  });
}

/** Cancels the still-booked occurrences of a series on or after a local date; returns how many. */
export function useCancelSeriesFrom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { seriesId: string; from: string }) => {
      const { data, error } = await supabase.rpc('cancel_series_from', {
        p_series_id: input.seriesId,
        p_from: input.from,
        p_idempotency_key: uuid(),
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  });
}

/**
 * Which listed appointments belong to a series. api.appointment_row has no series column (fixed
 * signature), so the agenda reads the link from the table, which staff may select.
 */
export function useSeriesLinks(appointmentIds: string[]) {
  const key = appointmentIds.join(',');
  return useQuery({
    enabled: appointmentIds.length > 0,
    queryKey: ['appointments', 'series-links', key],
    queryFn: async (): Promise<Map<string, string>> => {
      const { data, error } = await supabase
        .schema('app')
        .from('appointments')
        .select('id, series_id')
        .in('id', appointmentIds)
        .not('series_id', 'is', null);
      if (error) throw error;
      return new Map(data.map((r) => [r.id, r.series_id!]));
    },
  });
}

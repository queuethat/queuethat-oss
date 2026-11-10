import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

/** The settings an admin edits on the location page (A4, #44). The slug is read-only. */
export interface LocationSettings {
  name: string;
  address: string;
  contact: string;
  tz: string;
  /** Local time a new service day starts, as `HH:MM`. */
  dayBoundary: string;
  displayNamesEnabled: boolean;
  /** ISO 3166-1 alpha-2, e.g. `GB`; empty when not set. Guests' phone fields default to it. */
  country: string;
  /** Public joins must type the code shown on the display (2A-JN5). */
  onsiteCodeRequired: boolean;
  /** How often the code changes, 2-60 minutes. */
  onsiteCodeRotateMinutes: number;
  /** Thermal ticket roll width in mm (2B-D3). */
  printPaperMm: 58 | 80;
  /** Optional line at the bottom of a printed ticket; empty for none. */
  printFooter: string;
  /** Languages calls are announced in on the display, in order (2B-D6). */
  announceLocales: string[];
  /** Voice name and speed per language; voices are device-specific. */
  announceVoicePrefs: Record<string, { voice?: string; rate?: number }>;
  /** Times the whole call is spoken, 1-3. */
  announceRepeat: number;
  /** Premises position for geofenced queues (2B-Q10), as typed: both blank for none. */
  lat: string;
  lng: string;
  /** Radius in metres a geofenced queue accepts, 10-5000. */
  geofenceM: number;
}

/** The position as the database stores it, or null for both blank; undefined when only one is filled or out of range. */
export function parsePosition(
  lat: string,
  lng: string,
): { lat: number; lng: number } | null | undefined {
  if (lat.trim() === '' && lng.trim() === '') return null;
  const la = Number(lat);
  const ln = Number(lng);
  if (lat.trim() === '' || lng.trim() === '' || !(Math.abs(la) <= 90) || !(Math.abs(ln) <= 180))
    return undefined;
  return { lat: la, lng: ln };
}

/** One location's settings, read under RLS. */
export const locationSettingsQuery = (locationId: string) =>
  queryOptions({
    queryKey: ['admin', 'location', locationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('locations')
        .select(
          'slug, name, address, contact, tz, day_boundary, display_names_enabled, country_code, onsite_code_required, onsite_code_rotate_minutes, print_paper_mm, print_footer, announce_locales, announce_voice_prefs, announce_repeat, lat, lng, geofence_m',
        )
        .eq('id', locationId)
        .single();
      if (error) throw error;
      const settings: LocationSettings = {
        name: data.name,
        address: data.address ?? '',
        contact: data.contact ?? '',
        tz: data.tz,
        // Postgres renders the interval as HH:MM:SS; the time input wants HH:MM.
        dayBoundary: String(data.day_boundary).slice(0, 5),
        displayNamesEnabled: data.display_names_enabled,
        country: data.country_code ?? '',
        onsiteCodeRequired: data.onsite_code_required,
        onsiteCodeRotateMinutes: data.onsite_code_rotate_minutes,
        printPaperMm: data.print_paper_mm === 58 ? 58 : 80,
        printFooter: data.print_footer ?? '',
        announceLocales: data.announce_locales,
        announceVoicePrefs: data.announce_voice_prefs as LocationSettings['announceVoicePrefs'],
        announceRepeat: data.announce_repeat,
        lat: data.lat === null ? '' : String(data.lat),
        lng: data.lng === null ? '' : String(data.lng),
        geofenceM: data.geofence_m,
      };
      return { slug: data.slug, settings };
    },
  });

/**
 * Saves a location's settings. RLS lets only admins and owners update (`locations_update`), and
 * the audit trigger records the change. A row RLS hides comes back as `permission_denied`;
 * a zone Postgres doesn't know as `invalid_timezone`.
 */
export function useSaveLocationSettings(locationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: LocationSettings) => {
      const { data, error } = await supabase
        .schema('app')
        .from('locations')
        .update({
          name: settings.name.trim(),
          address: settings.address.trim() || null,
          contact: settings.contact.trim() || null,
          tz: settings.tz,
          day_boundary: settings.dayBoundary,
          display_names_enabled: settings.displayNamesEnabled,
          country_code: settings.country || null,
          onsite_code_required: settings.onsiteCodeRequired,
          onsite_code_rotate_minutes: settings.onsiteCodeRotateMinutes,
          print_paper_mm: settings.printPaperMm,
          print_footer: settings.printFooter.trim() || null,
          announce_locales: settings.announceLocales,
          announce_voice_prefs: settings.announceVoicePrefs,
          announce_repeat: settings.announceRepeat,
          lat: parsePosition(settings.lat, settings.lng)?.lat ?? null,
          lng: parsePosition(settings.lat, settings.lng)?.lng ?? null,
          geofence_m: settings.geofenceM,
        })
        .eq('id', locationId)
        .select('id');
      if (error) throw new Error(errorCode(error));
      if (data.length === 0) throw new Error('permission_denied');
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'location', locationId] });
      // The header shows the location's name.
      await queryClient.invalidateQueries({ queryKey: ['auth', 'locations'] });
    },
  });
}

/** Roles that may change location settings; the database enforces the same ladder. */
export const canEditLocation = (role: string | undefined) => role === 'admin' || role === 'owner';

import { queryOptions } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';

export interface HeatCell {
  /** 0 = Sunday. */
  dow: number;
  hour: number;
  avgArrivals: number;
  avgWaitMin: number | null;
  suggestedStaff: number;
  /** People rostered in that hour; null when the location has no shifts at all. */
  scheduledStaff: number | null;
}

/**
 * Arrivals, waits and suggested staff by local weekday and hour, from `api.peak_heatmap`. The
 * database owns the staffing arithmetic; the page only draws it.
 */
export const heatmapQuery = (locationId: string, weeks: number) =>
  queryOptions({
    queryKey: ['admin', 'heatmap', locationId, weeks],
    queryFn: async (): Promise<HeatCell[]> => {
      const { data, error } = await supabase.rpc('peak_heatmap', {
        p_location_id: locationId,
        p_weeks: weeks,
      });
      if (error) throw error;
      return data.map((c) => ({
        dow: c.dow ?? 0,
        hour: c.hour ?? 0,
        avgArrivals: c.avg_arrivals ?? 0,
        avgWaitMin: c.avg_wait_min,
        suggestedStaff: c.suggested_staff ?? 0,
        scheduledStaff: c.scheduled_staff,
      }));
    },
  });

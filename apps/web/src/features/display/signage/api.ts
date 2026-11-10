import { appConfig } from '../../../lib/config.ts';
import { useLiveQuery } from '../../../lib/live.ts';
import { supabase } from '../../../lib/supabase.ts';

/** A slide as the TV shows it. */
export interface DisplaySlide {
  kind: 'image' | 'text';
  imageUrl: string | null;
  body: string | null;
  durationS: number;
}

async function fetchSignage(locationId: string): Promise<DisplaySlide[]> {
  const { data, error } = await supabase.rpc('display_signage', { p_location_id: locationId });
  if (error) throw error;
  const origin = appConfig().supabaseUrl;
  return (data ?? []).map((s) => ({
    kind: s.kind === 'image' ? 'image' : 'text',
    imageUrl: s.image_url?.startsWith('/storage/') ? origin + s.image_url : null,
    body: s.body,
    durationS: s.duration_s ?? 10,
  }));
}

/**
 * The slides active now for the TV's location (`api.display_signage`). Slides change rarely and
 * carry no call signal, so this polls every minute, which also lets a schedule window open or
 * close without a reload. A failed read keeps the last slides.
 */
export function useDisplaySignage(locationId: string | undefined) {
  return useLiveQuery({
    queryKey: ['display', 'signage', locationId],
    queryFn: () => fetchSignage(locationId ?? ''),
    topic: null,
    enabled: !!locationId,
    pollMs: () => 60_000,
  });
}

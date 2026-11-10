import { errorCode } from '@qm/domain';
import { useLiveQuery } from '../../../lib/live.ts';
import { supabase } from '../../../lib/supabase.ts';
import type { AnnounceSettings, VoicePref } from './announce.ts';

const DEFAULTS: AnnounceSettings = { locales: ['en'], voicePrefs: {}, repeat: 1 };

async function fetchAnnounceSettings(locationId: string): Promise<AnnounceSettings> {
  const { data, error } = await supabase
    .schema('app')
    .from('locations')
    .select('announce_locales, announce_voice_prefs, announce_repeat')
    .eq('id', locationId)
    .single();
  if (error) throw new Error(errorCode(error));
  return {
    locales: data.announce_locales.length > 0 ? data.announce_locales : DEFAULTS.locales,
    voicePrefs: data.announce_voice_prefs as Record<string, VoicePref>,
    repeat: data.announce_repeat,
  };
}

/**
 * Which languages and voices the display announces calls in (2B-D6). Paired devices read their
 * location row under RLS; a settings change signals the location's topic, so the display picks it
 * up within seconds. Until it loads (or if it fails) calls are announced in English once.
 */
export function useAnnounceSettings(locationId: string | undefined): AnnounceSettings {
  const query = useLiveQuery({
    queryKey: ['display', 'announce-settings', locationId],
    queryFn: () => fetchAnnounceSettings(locationId ?? ''),
    topic: locationId ? `loc:${locationId}` : null,
    enabled: !!locationId,
    jitterMs: 0,
  });
  return query.data ?? DEFAULTS;
}

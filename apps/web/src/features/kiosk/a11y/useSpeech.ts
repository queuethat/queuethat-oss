import { useEffect, useMemo } from 'react';
import { createSpeech, spokenName, type Speech } from './speech.ts';

/**
 * While `enabled`, speaks the name of each control that takes focus, in `lang`. The kiosk adds
 * the screen title and the ticket confirmation through the returned `say`. Turning it off, or
 * leaving the kiosk, silences anything in progress.
 */
export function useSpeech(enabled: boolean, lang: string): Speech {
  const speech = useMemo(() => createSpeech(), []);
  useEffect(() => {
    if (!enabled) return;
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Element) speech.say(spokenName(event.target), lang);
    };
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('focusin', onFocus);
      speech.stop();
    };
  }, [enabled, lang, speech]);
  return speech;
}

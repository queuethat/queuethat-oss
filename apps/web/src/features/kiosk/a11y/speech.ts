/** The slice of the browser's speech synthesis the kiosk uses. Injected in tests. */
export interface Synth {
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
}

export interface Speech {
  /** Speaks `text` in `lang`, cutting off whatever is being said: guidance follows the guest's focus, never lags behind it. */
  say(text: string, lang: string): void;
  stop(): void;
}

/**
 * Audio guidance for the kiosk (D-9) on the Web Speech API: free, works offline on most devices
 * and plays through the headphone jack. Does nothing where speech is unavailable.
 */
export function createSpeech(
  synth: Synth | undefined = globalThis.speechSynthesis,
  Utterance: typeof SpeechSynthesisUtterance | undefined = globalThis.SpeechSynthesisUtterance,
): Speech {
  return {
    say(text, lang) {
      if (!synth || !Utterance || text.trim() === '') return;
      synth.cancel();
      const utterance = new Utterance(text);
      utterance.lang = lang;
      synth.speak(utterance);
    },
    stop() {
      synth?.cancel();
    },
  };
}

/** What a screen reader would say for a focused control: its label, then its value if it has one. */
export function spokenName(el: Element): string {
  const own = el.getAttribute('aria-label');
  const labelled = (el as HTMLInputElement).labels?.[0]?.textContent;
  const name = (own ?? labelled ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const value = el instanceof HTMLSelectElement ? el.selectedOptions[0]?.textContent?.trim() : '';
  return value ? `${name}, ${value}` : name;
}

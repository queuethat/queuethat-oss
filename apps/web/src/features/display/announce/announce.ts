// D-2 (#121): the chime and the spoken call on the waiting-room TV. Pure logic and a thin
// browser adapter, so the ordering rules are testable without audio.

export type AnnounceMode = 'off' | 'chime' | 'chime-speech';

const MODE_KEY = 'qm:display:sound';
const MODES: readonly AnnounceMode[] = ['off', 'chime', 'chime-speech'];

/** The sound mode saved on this device. Off until someone turns it on at the TV. */
export function readMode(): AnnounceMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return MODES.includes(saved as AnnounceMode) ? (saved as AnnounceMode) : 'off';
  } catch {
    return 'off';
  }
}

export function storeMode(mode: AnnounceMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // storage unavailable: the choice lasts until the page reloads
  }
}

/** The voice an admin picked for a language: a device voice name and a speaking rate. */
export interface VoicePref {
  voice?: string;
  rate?: number;
}

/** One spoken phrase of a call: its text, language and the voice chosen for that language. */
export interface Utterance extends VoicePref {
  text: string;
  lang: string;
}

/** What the browser does with sound. Injected in tests. */
export interface Speaker {
  chime(): Promise<void>;
  /** Resolves when the phrase has been spoken (or could not be). */
  speak(text: string, lang: string, voice?: VoicePref): Promise<void>;
  /** Called from a tap: browsers keep audio locked until a gesture. */
  unlock(): void;
}

/** Longest the queue waits for one phrase to finish before moving on. */
const SPEECH_TIMEOUT_MS = 15_000;

export function browserSpeaker(): Speaker {
  let context: AudioContext | null = null;
  const audio = () => {
    const Ctor = globalThis.AudioContext;
    if (!Ctor) return null;
    context ??= new Ctor();
    return context;
  };
  return {
    unlock() {
      void audio()?.resume();
      // An empty phrase also unlocks speech on browsers that gate it behind a gesture.
      globalThis.speechSynthesis?.speak(new SpeechSynthesisUtterance(''));
    },
    chime() {
      const ctx = audio();
      if (!ctx) return Promise.resolve();
      const start = ctx.currentTime;
      // Two soft notes, a fourth apart, so it reads as "attention" without being alarming.
      for (const [i, hz] of [660, 880].entries()) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = hz;
        gain.gain.setValueAtTime(0.0001, start + i * 0.28);
        gain.gain.exponentialRampToValueAtTime(0.35, start + i * 0.28 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.28 + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start + i * 0.28);
        osc.stop(start + i * 0.28 + 0.55);
      }
      return new Promise((resolve) => setTimeout(resolve, 850));
    },
    speak(text, lang, pref) {
      const synth = globalThis.speechSynthesis;
      if (!synth) return Promise.resolve();
      return new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = lang;
        // Voice by language: the browser's default voice is often the wrong language.
        const base = lang.split('-')[0]!.toLowerCase();
        const voices = synth.getVoices();
        // The admin's pick wins; a voice this device doesn't have falls back to one in the language.
        const voice =
          voices.find((v) => pref?.voice && v.name === pref.voice) ??
          voices.find((v) => v.lang.toLowerCase().startsWith(base));
        if (voice) utterance.voice = voice;
        if (pref?.rate) utterance.rate = pref.rate;
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, SPEECH_TIMEOUT_MS);
        utterance.onend = done;
        utterance.onerror = done;
        synth.speak(utterance);
      });
    },
  };
}

export interface Announcer {
  /** Queues a call (one phrase per language); calls play one after another, in the order they arrive. */
  enqueue(call: readonly Utterance[]): void;
}

/**
 * Plays queued calls strictly one at a time: chime, then (in chime + speech mode) the phrase,
 * then the next call. The mode is read when a call starts, so turning sound off at the TV
 * silences what is still waiting.
 */
export function createAnnouncer(
  speaker: Speaker,
  mode: () => AnnounceMode,
  repeat: () => number = () => 1,
): Announcer {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(call) {
      tail = tail.then(async () => {
        const current = mode();
        if (current === 'off') return;
        await speaker.chime().catch(() => {});
        if (current !== 'chime-speech') return;
        // The whole multilingual call, in the configured order, then again `repeat` times.
        for (let round = 0; round < repeat(); round++) {
          for (const u of call) await speaker.speak(u.text, u.lang, u).catch(() => {});
        }
      });
    },
  };
}

/** The ticket and where to go, and a name only when the snapshot carried one. */
export interface CalledTicket {
  display_ticket: string | null;
  counter_label: string | null;
  first_name: string | null;
}

type CallKey = 'call' | 'callTicket' | 'callNamed' | 'callNamedTicket';
type Translate = (
  key: CallKey,
  options: { ticket: string; counter: string; name: string },
) => string;

/**
 * "A012" as "A 0 1 2": spoken one character at a time, so a voice never reads it as a number
 * ("twelve") and each language says its own digits.
 */
export function spellTicket(ticket: string): string {
  return [...ticket].join(' ');
}

/**
 * The phrase for one call, from the `announce` locale files. The name is spoken only when the
 * snapshot carries it, which the database does only for locations that opted in (never for
 * health-tagged orgs), so a ticket and counter are all a room hears by default.
 */
export function callPhrase(t: Translate, ticket: CalledTicket): string {
  const key: CallKey = ticket.first_name
    ? ticket.counter_label
      ? 'callNamed'
      : 'callNamedTicket'
    : ticket.counter_label
      ? 'call'
      : 'callTicket';
  return t(key, {
    ticket: spellTicket(ticket.display_ticket ?? ''),
    counter: ticket.counter_label ?? '',
    name: ticket.first_name ?? '',
  });
}

/** What a location announces: languages in order, a voice per language, and how many times. */
export interface AnnounceSettings {
  locales: readonly string[];
  voicePrefs: Readonly<Record<string, VoicePref>>;
  repeat: number;
}

/** One utterance per configured language for `ticket`, each with that language's voice. */
export function callUtterances(
  settings: AnnounceSettings,
  translateFor: (locale: string) => Translate,
  ticket: CalledTicket,
): Utterance[] {
  return settings.locales.map((lang) => ({
    text: callPhrase(translateFor(lang), ticket),
    lang,
    ...settings.voicePrefs[lang],
  }));
}

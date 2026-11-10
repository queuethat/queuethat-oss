import type { Database } from '@qm/db-types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import i18next from '../../../lib/i18n.ts';
import { callKey, newCalls } from '../highlight.ts';
import {
  browserSpeaker,
  callUtterances,
  type CalledTicket,
  createAnnouncer,
  type AnnounceSettings,
  type Announcer,
  readMode,
  storeMode,
  type AnnounceMode,
  type Speaker,
} from './announce.ts';

const DEFAULT_SETTINGS: AnnounceSettings = { locales: ['en'], voicePrefs: {}, repeat: 1 };

type Snapshot = Database['api']['CompositeTypes']['display_snapshot'];

/**
 * Chimes and speaks each new call on the TV. Calls already on screen when the board first has
 * data are not announced, so a TV that reloads doesn't read the whole room out again. Audio
 * stays locked until `unlock` runs from a tap.
 */
export function useAnnouncements(
  snapshot: Snapshot | null | undefined,
  speaker?: Speaker,
  settings: AnnounceSettings = DEFAULT_SETTINGS,
) {
  const [mode, setModeState] = useState<AnnounceMode>(readMode);
  const [unlocked, setUnlocked] = useState(false);
  const sound = useMemo(() => speaker ?? browserSpeaker(), [speaker]);
  const latest = useRef({ mode, unlocked, settings });
  useEffect(() => {
    latest.current = { mode, unlocked, settings };
  });
  // Each configured language's phrases load before its first call is announced.
  const localesKey = settings.locales.join(' ');
  const [ready, setReady] = useState('');
  useEffect(() => {
    let current = true;
    // Explicit language and namespace: loadNamespaces would load only the active UI language.
    void i18next
      .reloadResources([...new Set(['en', ...settings.locales])], 'announce')
      .then(() => current && setReady(localesKey));
    return () => {
      current = false;
    };
  }, [localesKey, settings.locales]);
  const translateFor = useCallback(
    (locale: string) => i18next.getFixedT(locale, 'announce') as never,
    [],
  );
  const [announcer, setAnnouncer] = useState<Announcer | null>(null);
  useEffect(() => {
    setAnnouncer(
      createAnnouncer(
        sound,
        () => (latest.current.unlocked ? latest.current.mode : 'off'),
        () => latest.current.settings.repeat,
      ),
    );
  }, [sound]);
  const seen = useRef<Set<string> | null>(null);

  // Calls that arrived before the configured languages finished loading wait here.
  const pending = useRef<CalledTicket[]>([]);
  const isReady = ready === localesKey;
  const play = useCallback(
    (tickets: CalledTicket[]) => {
      for (const ticket of tickets) {
        announcer?.enqueue(callUtterances(latest.current.settings, translateFor, ticket));
      }
    },
    [announcer, translateFor],
  );

  useEffect(() => {
    if (!snapshot) return;
    const tickets = (snapshot.queues ?? []).flatMap((q) => q.now_serving ?? []);
    const fresh = new Set(newCalls(seen.current, tickets.map(callKey)));
    seen.current = new Set([...(seen.current ?? []), ...tickets.map(callKey)]);
    const calls = tickets.filter((ticket) => fresh.has(callKey(ticket)));
    if (isReady && announcer) play(calls);
    else pending.current.push(...calls);
  }, [snapshot, announcer, isReady, play]);

  useEffect(() => {
    if (!isReady || !announcer) return;
    play(pending.current);
    pending.current = [];
  }, [isReady, announcer, play]);

  return {
    mode,
    unlocked,
    setMode(next: AnnounceMode) {
      storeMode(next);
      setModeState(next);
    },
    unlock() {
      sound.unlock();
      setUnlocked(true);
    },
    /** Plays a sample call so staff can set the volume. */
    test() {
      sound.unlock();
      announcer?.enqueue(
        settings.locales.map((lang) => ({
          text: i18next.getFixedT(lang, 'announce')('test'),
          lang,
          ...settings.voicePrefs[lang],
        })),
      );
    },
  };
}

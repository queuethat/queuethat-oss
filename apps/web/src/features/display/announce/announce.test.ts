import { act, renderHook } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { createAnnouncer, spellTicket, type AnnounceMode, type Speaker } from './announce.ts';
import { useAnnouncements } from './useAnnouncements.ts';

beforeAll(() => loadNamespaces('display', 'announce'));
beforeEach(() => localStorage.clear());

/** A speaker whose phrases finish only when the test says so, like a real voice. */
function fakeSpeaker() {
  const spoken: string[] = [];
  const finishers: Array<() => void> = [];
  const chimes: number[] = [];
  const calls: Array<{ text: string; lang: string; voice?: string; rate?: number }> = [];
  const speaker: Speaker = {
    unlock: vi.fn(),
    chime: async () => void chimes.push(spoken.length),
    speak: (text, lang, pref) =>
      new Promise<void>((resolve) => {
        spoken.push(text);
        calls.push({ text, lang, ...pref });
        finishers.push(resolve);
      }),
  };
  return { speaker, spoken, calls, chimes, finish: () => finishers.shift()?.() };
}

// Languages load through a dynamic import, which is slow on a cold Vite cache: give them a moment.
const flush = () => act(() => new Promise((r) => setTimeout(r, 150)));

const snapshot = (calls: Array<[string, string | null, string | null, string]>) => ({
  location_id: 'l',
  location_name: 'Main',
  names_enabled: calls.some((c) => c[2]),
  as_of: '2026-10-30T10:00:00Z',
  queues: [
    {
      id: 'q',
      name: 'Walk-ins',
      state: 'open' as const,
      now_serving: calls.map(([display_ticket, counter_label, first_name, called_at]) => ({
        display_ticket,
        counter_label,
        first_name,
        called_at,
      })),
      next_up: [],
    },
  ],
});

function board(speaker: Speaker, mode: AnnounceMode = 'chime-speech') {
  localStorage.setItem('qm:display:sound', mode);
  const hook = renderHook(({ snap }) => useAnnouncements(snap, speaker), {
    initialProps: { snap: snapshot([]) },
  });
  act(() => hook.result.current.unlock());
  return hook;
}

describe('useAnnouncements', () => {
  // AC1 (#121)
  it('speaks "Ticket A 1 2, Chair 2" once for a new call, after a chime', async () => {
    const { speaker, spoken, chimes } = fakeSpeaker();
    const hook = board(speaker);
    hook.rerender({ snap: snapshot([['A12', 'Chair 2', null, '2026-10-30T10:01:00Z']]) });
    await flush();
    expect(spoken).toEqual(['Ticket A 1 2, Chair 2']);
    expect(chimes).toHaveLength(1);
    // The same snapshot again is not a new call.
    hook.rerender({ snap: snapshot([['A12', 'Chair 2', null, '2026-10-30T10:01:00Z']]) });
    await flush();
    expect(spoken).toHaveLength(1);
  });

  // AC2 (#121)
  it('says no name when the snapshot carries none (names disabled)', async () => {
    const { speaker, spoken } = fakeSpeaker();
    const hook = board(speaker);
    hook.rerender({ snap: snapshot([['A13', 'Chair 1', null, '2026-10-30T10:02:00Z']]) });
    await flush();
    expect(spoken[0]).toBe('Ticket A 1 3, Chair 1');
    expect(spoken[0]).not.toMatch(/Dana/);
  });

  it('adds the name only when the snapshot has one', async () => {
    const { speaker, spoken } = fakeSpeaker();
    const hook = board(speaker);
    hook.rerender({ snap: snapshot([['A14', 'Chair 1', 'Dana', '2026-10-30T10:03:00Z']]) });
    await flush();
    expect(spoken[0]).toBe('Ticket A 1 4, Dana, Chair 1');
  });

  // AC3 (#121)
  it('plays two calls one second apart one after the other', async () => {
    const { speaker, spoken, finish } = fakeSpeaker();
    const hook = board(speaker);
    hook.rerender({ snap: snapshot([['A20', 'Chair 1', null, '2026-10-30T10:04:00Z']]) });
    await flush();
    hook.rerender({
      snap: snapshot([
        ['A20', 'Chair 1', null, '2026-10-30T10:04:00Z'],
        ['A21', 'Chair 2', null, '2026-10-30T10:04:01Z'],
      ]),
    });
    await flush();
    expect(spoken).toEqual(['Ticket A 2 0, Chair 1']);
    act(() => finish());
    await flush();
    expect(spoken).toEqual(['Ticket A 2 0, Chair 1', 'Ticket A 2 1, Chair 2']);
  });

  it('repeats a recall (a new called_at is a new call)', async () => {
    const { speaker, spoken, finish } = fakeSpeaker();
    const hook = board(speaker);
    hook.rerender({ snap: snapshot([['A30', 'Chair 1', null, '2026-10-30T10:05:00Z']]) });
    await flush();
    act(() => finish());
    hook.rerender({ snap: snapshot([['A30', 'Chair 1', null, '2026-10-30T10:06:00Z']]) });
    await flush();
    expect(spoken).toEqual(['Ticket A 3 0, Chair 1', 'Ticket A 3 0, Chair 1']);
  });

  it('does not announce what was on screen at load, and chime mode does not speak', async () => {
    const first = fakeSpeaker();
    localStorage.setItem('qm:display:sound', 'chime');
    const hook = renderHook(({ snap }) => useAnnouncements(snap, first.speaker), {
      initialProps: { snap: snapshot([['A40', 'Chair 1', null, '2026-10-30T10:07:00Z']]) },
    });
    act(() => hook.result.current.unlock());
    await flush();
    expect(first.chimes).toHaveLength(0);
    hook.rerender({
      snap: snapshot([
        ['A40', 'Chair 1', null, '2026-10-30T10:07:00Z'],
        ['A41', 'Chair 1', null, '2026-10-30T10:08:00Z'],
      ]),
    });
    await flush();
    expect(first.chimes).toHaveLength(1);
    expect(first.spoken).toEqual([]);
  });

  it('stays silent while audio is locked or the mode is off, and keeps the mode on the device', async () => {
    const { speaker, spoken, chimes } = fakeSpeaker();
    const hook = renderHook(({ snap }) => useAnnouncements(snap, speaker), {
      initialProps: { snap: snapshot([]) },
    });
    expect(hook.result.current.mode).toBe('off');
    act(() => hook.result.current.unlock());
    hook.rerender({ snap: snapshot([['A50', 'Chair 1', null, '2026-10-30T10:09:00Z']]) });
    await flush();
    expect(chimes).toHaveLength(0);
    act(() => hook.result.current.setMode('chime-speech'));
    expect(localStorage.getItem('qm:display:sound')).toBe('chime-speech');
    expect(spoken).toEqual([]);
  });
});

describe('createAnnouncer', () => {
  it('re-reads the mode for every queued call', async () => {
    const { speaker, spoken } = fakeSpeaker();
    let mode: AnnounceMode = 'chime-speech';
    const announcer = createAnnouncer(speaker, () => mode);
    announcer.enqueue([{ text: 'one', lang: 'en' }]);
    await flush();
    mode = 'off';
    announcer.enqueue([{ text: 'two', lang: 'en' }]);
    await flush();
    expect(spoken).toEqual(['one']);
  });
});

// 2B-D7 (#264)
describe('multilingual calls', () => {
  const settings = {
    locales: ['en', 'fr'],
    voicePrefs: { fr: { voice: 'Amelie', rate: 0.9 } },
    repeat: 1,
  };

  function boardWith(speaker: Speaker, withSettings = settings) {
    localStorage.setItem('qm:display:sound', 'chime-speech');
    const hook = renderHook(({ snap }) => useAnnouncements(snap, speaker, withSettings), {
      initialProps: { snap: snapshot([]) },
    });
    act(() => hook.result.current.unlock());
    return hook;
  }

  it('AC1: A012 to counter 3 queues English then French, each with its own voice', async () => {
    const { speaker, calls, finish } = fakeSpeaker();
    const hook = boardWith(speaker);
    await flush();
    hook.rerender({ snap: snapshot([['A012', '3', null, '2026-10-30T10:10:00Z']]) });
    // The configured languages load lazily, which can outlast one flush on a loaded machine.
    await vi.waitFor(() => expect(calls).toEqual([{ text: 'Ticket A 0 1 2, 3', lang: 'en' }]));
    act(() => finish());
    await vi.waitFor(() =>
      expect(calls[1]).toEqual({
        text: 'Ticket A 0 1 2, 3',
        lang: 'fr',
        voice: 'Amelie',
        rate: 0.9,
      }),
    );
  });

  it('AC2: two calls within 2 s never overlap, and repeat plays the whole call again', async () => {
    const { speaker, spoken, finish } = fakeSpeaker();
    const hook = boardWith(speaker, { ...settings, locales: ['en'], repeat: 2 });
    await flush();
    hook.rerender({
      snap: snapshot([
        ['A1', '3', null, '2026-10-30T10:11:00Z'],
        ['B2', '4', null, '2026-10-30T10:11:01Z'],
      ]),
    });
    // Lazy locale loading can outlast one flush on a loaded machine.
    await vi.waitFor(() => expect(spoken).toEqual(['Ticket A 1, 3']));
    for (let i = 0; i < 3; i++) {
      act(() => finish());
      await flush();
    }
    expect(spoken).toEqual(['Ticket A 1, 3', 'Ticket A 1, 3', 'Ticket B 2, 4', 'Ticket B 2, 4']);
  });
});

describe('spellTicket', () => {
  it('spells every character apart', () => {
    expect(spellTicket('A012')).toBe('A 0 1 2');
  });
});

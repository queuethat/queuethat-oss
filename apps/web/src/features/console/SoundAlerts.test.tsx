import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import type { ConsoleVisit } from './api.ts';
import { SoundAlerts } from './SoundAlerts.tsx';

/** Counts beeps: each pulse of the chime is one oscillator. */
let beeps = 0;
class FakeAudioContext {
  currentTime = 0;
  destination = {};
  resume = async () => {};
  close = async () => {};
  createOscillator() {
    beeps++;
    return { frequency: {}, connect: (n: unknown) => n, start() {}, stop() {} };
  }
  createGain() {
    const node = {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (n: unknown) => n,
    };
    return node;
  }
}

const visit = (id: string, status: ConsoleVisit['status'] = 'waiting'): ConsoleVisit => ({
  id,
  queueId: 'q1',
  ticket: id,
  status,
  name: null,
  partySize: 1,
  groupKey: null,
  expectedMinutes: null,
  onTheWay: false,
  priorityClassId: null,
  arriveAfter: null,
  guestId: null,
  service: null,
  counter: null,
  source: 'online',
  scheduledAt: null,
  earlyUntil: null,
  lateAfter: null,
  since: '2026-10-25T10:00:00Z',
  joinedAt: '2026-10-25T10:00:00Z',
  assignedStaffId: null,
  assignedCounterId: null,
  notes: '',
  tags: [],
  version: 1,
  actions: [],
});

// The hook reads `window.AudioContext`, which jsdom lacks.
const audio = (ctor: unknown) => Object.assign(window, { AudioContext: ctor });

beforeAll(() => loadNamespaces('staff'));
beforeEach(() => {
  beeps = 0;
  audio(FakeAudioContext);
});
afterEach(() => {
  cleanup();
  audio(undefined);
});

describe('SoundAlerts', () => {
  it('shows the sound banner until tapped, then a sound-on indicator (AC1)', () => {
    render(<SoundAlerts visits={[]} />);
    expect(screen.getByRole('region', { name: 'Sound alerts' }).textContent).toContain(
      'Sound is off',
    );
    expect(screen.getByText(/side mute switch/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on sound' }));
    expect(beeps).toBe(1); // the speaker test
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Sound on');
    fireEvent.click(screen.getByRole('button', { name: 'Test sound' }));
    expect(beeps).toBe(3);
  });

  it('chimes for a new waiting visit, not for the first list or for status changes', () => {
    const { rerender } = render(<SoundAlerts visits={[visit('a')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on sound' }));
    beeps = 0;
    rerender(<SoundAlerts visits={[visit('a', 'called')]} />);
    expect(beeps).toBe(0);
    rerender(<SoundAlerts visits={[visit('a', 'called'), visit('b')]} />);
    expect(beeps).toBe(2);
  });

  it('stays quiet when muted and before sound is turned on', () => {
    const { rerender } = render(<SoundAlerts visits={[]} />);
    rerender(<SoundAlerts visits={[visit('a')]} />);
    expect(beeps).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on sound' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    beeps = 0;
    rerender(<SoundAlerts visits={[visit('a'), visit('b')]} />);
    expect(beeps).toBe(0);
    expect(screen.getByRole('status').textContent).toContain('Sound muted');
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Unmute' })));
    rerender(<SoundAlerts visits={[visit('a'), visit('b'), visit('c')]} />);
    expect(beeps).toBe(2);
  });

  it('shows nothing where the browser has no Web Audio', () => {
    audio(undefined);
    const { container } = render(<SoundAlerts visits={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

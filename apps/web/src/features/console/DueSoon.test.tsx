import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import type { ConsoleVisit } from './api.ts';
import { dueSoon } from './DueSoon.tsx';
import { VisitList } from './VisitList.tsx';

beforeAll(() => loadNamespaces('staff'));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.parse('2026-10-25T10:00:00Z');
const visit = (over: Partial<ConsoleVisit>): ConsoleVisit => ({
  id: crypto.randomUUID(),
  queueId: 'q',
  ticket: 'A001',
  status: 'waiting',
  name: 'Dana',
  partySize: 1,
  groupKey: null,
  expectedMinutes: null,
  onTheWay: false,
  priorityClassId: null,
  arriveAfter: null,
  guestId: null,
  service: 'Haircut',
  counter: null,
  source: 'online',
  scheduledAt: null,
  earlyUntil: null,
  lateAfter: null,
  since: '2026-10-25T09:48:00Z',
  joinedAt: '2026-10-25T09:48:00Z',
  assignedStaffId: null,
  assignedCounterId: null,
  notes: '',
  tags: [],
  version: 1,
  actions: [],
  ...over,
});

// An appointment starting `minutes` from NOW with the default 10-minute early and late windows.
const appointment = (minutes: number, over: Partial<ConsoleVisit> = {}) => {
  const at = NOW + minutes * 60_000;
  return visit({
    status: 'expected',
    source: 'appointment',
    scheduledAt: new Date(at).toISOString(),
    since: new Date(at).toISOString(),
    earlyUntil: new Date(at - 10 * 60_000).toISOString(),
    lateAfter: new Date(at + 10 * 60_000).toISOString(),
    actions: ['check_in', 'cancel'],
    ...over,
  });
};

describe('dueSoon', () => {
  it('lists booked guests starting within 15 minutes, or just started, soonest first', () => {
    const later = appointment(12, { ticket: 'A002' });
    const sooner = appointment(5, { ticket: 'A001' });
    const justStarted = appointment(-4, { ticket: 'A000' });
    expect(dueSoon([later, sooner, justStarted], NOW).map((v) => v.ticket)).toEqual([
      'A000',
      'A001',
      'A002',
    ]);
  });

  it('leaves out far-off, late, checked-in and join-later guests', () => {
    const far = appointment(40);
    const late = appointment(-15);
    const waiting = appointment(5, { status: 'waiting' });
    const forLater = appointment(5, { arriveAfter: new Date(NOW + 300_000).toISOString() });
    expect(dueSoon([far, late, waiting, forLater, visit({})], NOW)).toEqual([]);
  });
});

describe('the console cue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });

  it('shows who is due, when, and a hint, above the sections', () => {
    render(
      <VisitList
        timeZone="UTC"
        visits={[appointment(5, { ticket: 'A010', name: 'Sue' }), visit({ ticket: 'A011' })]}
      />,
    );
    const cue = screen.getByTestId('due-soon');
    expect(within(cue).getByText('Appointment due soon')).toBeTruthy();
    expect(within(cue).getByText(/A010 Sue · due 10:05.*in 5 min.*not checked in/)).toBeTruthy();
    expect(within(cue).getByText(/Leave a gap/)).toBeTruthy();
  });

  it('is absent when nobody is due soon', () => {
    render(<VisitList timeZone="UTC" visits={[appointment(60), visit({})]} />);
    expect(screen.queryByTestId('due-soon')).toBeNull();
  });
});

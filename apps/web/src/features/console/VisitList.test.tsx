import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import type { ConsoleQueue, ConsoleVisit } from './api.ts';
import { arrivalState, mainAction, minutesSince, VisitList } from './VisitList.tsx';

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

describe('VisitList', () => {
  it('badges a guest who said they are on the way, and only that guest', () => {
    render(
      <VisitList
        visits={[
          visit({ ticket: 'A001', status: 'called', onTheWay: true }),
          visit({ ticket: 'A002' }),
        ]}
      />,
    );
    const badges = screen.getAllByTestId('on-the-way-badge');
    expect(badges.map((b) => b.textContent)).toEqual(['On the way']);
  });

  it('badges visits that joined together with the other tickets of their group', () => {
    render(
      <VisitList
        visits={[
          visit({ ticket: 'A001', groupKey: 'g1' }),
          visit({ ticket: 'A002' }),
          visit({ ticket: 'A003', groupKey: 'g1', status: 'called' }),
        ]}
      />,
    );
    const badges = screen.getAllByTestId('group-badge');
    expect(badges.map((b) => b.textContent)).toEqual(['Group with A003', 'Group with A001']);
  });

  it('shows waiting, called and serving in the order given, with counts and times', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    render(
      <VisitList
        visits={[
          visit({
            ticket: 'A003',
            status: 'serving',
            counter: 'Chair 1',
            since: '2026-10-25T09:55:00Z',
          }),
          visit({ ticket: 'A004', name: null, partySize: 3 }),
          visit({ ticket: 'A002', since: '2026-10-25T09:59:40Z' }),
        ]}
      />,
    );
    const waiting = screen.getByTestId('section-waiting');
    expect(within(waiting).getByRole('heading').textContent).toBe('Waiting (2)');
    const rows = within(waiting).getAllByTestId('visit');
    expect(rows.map((r) => r.textContent)).toEqual([
      'A004No name given · party of 3HaircutWaited 12 min',
      'A002DanaHaircutJust joined',
    ]);
    expect(screen.getByTestId('section-called').textContent).toContain('No one has been called.');
    expect(screen.getByTestId('section-serving').textContent).toContain(
      'A003DanaHaircut · Chair 1Serving for 5 min',
    );
  });

  it('never shows a negative time when the tablet clock is behind', () => {
    expect(minutesSince('2026-10-25T10:05:00Z', NOW)).toBe(0);
    expect(minutesSince('2026-10-25T09:00:00Z', NOW)).toBe(60);
  });

  it('offers Call only on rows whose allowed_actions include it', () => {
    const onAction = vi.fn();
    const callable = visit({ ticket: 'A005', actions: ['call', 'cancel'] });
    render(
      <VisitList
        visits={[callable, visit({ ticket: 'A006', actions: ['cancel'] })]}
        onAction={onAction}
      />,
    );
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Call A005',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Call A005' }));
    expect(onAction).toHaveBeenCalledWith(callable, 'call');
  });

  it('shows no actions when the screen gives no handler', () => {
    render(<VisitList visits={[visit({ actions: ['call'] })]} />);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('removes only after a reason and a separate confirm', async () => {
    const onAction = vi.fn();
    const row = visit({ ticket: 'A007', actions: ['call', 'no_show', 'remove'] });
    render(<VisitList visits={[row]} onAction={onAction} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More actions for A007' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(screen.getByTestId('confirm-guest').textContent).toBe('Guest: Dana (A007)');
    const confirm = screen.getByRole('button', { name: 'Remove' });
    expect(confirm).toHaveProperty('disabled', true);
    await user.click(confirm);
    expect(onAction).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Reason'), '  Duplicate ticket ');
    await user.click(confirm);
    expect(onAction).toHaveBeenCalledWith(row, 'remove', 'Duplicate ticket');
  });

  it('lists expected appointments with their time, a text badge and a check-in button', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const onAction = vi.fn();
    render(
      <VisitList
        timeZone="UTC"
        onAction={onAction}
        visits={[
          visit({
            ticket: 'A010',
            status: 'expected',
            source: 'appointment',
            since: '2026-10-25T09:40:00Z',
            scheduledAt: '2026-10-25T09:40:00Z',
            earlyUntil: '2026-10-25T09:30:00Z',
            lateAfter: '2026-10-25T09:50:00Z',
            actions: ['check_in', 'cancel'],
          }),
        ]}
      />,
    );
    const section = screen.getByTestId('section-expected');
    expect(within(section).getByTestId('arrival-badge').textContent).toBe('Late');
    expect(within(section).getByText(/Due/)).toBeTruthy();
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(within(section).getByRole('button', { name: 'Check in A010' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ ticket: 'A010' }), 'check_in');
  });

  it('badges a waiting appointment as such, and labels arrivals from the thresholds', () => {
    render(<VisitList visits={[visit({ source: 'appointment', ticket: 'A011' })]} />);
    expect(screen.getByTestId('appointment-badge').textContent).toBe('Appointment');
    const v = visit({ earlyUntil: '2026-10-25T09:30:00Z', lateAfter: '2026-10-25T09:50:00Z' });
    expect(arrivalState(v, Date.parse('2026-10-25T09:00:00Z'))).toBe('early');
    expect(arrivalState(v, Date.parse('2026-10-25T09:40:00Z'))).toBe('onTime');
    expect(arrivalState(v, Date.parse('2026-10-25T10:00:00Z'))).toBe('late');
    expect(arrivalState(visit({}), NOW)).toBeNull();
  });

  it('draws one primary action per row: Call on a waiting guest, Start on a called one', () => {
    render(
      <VisitList
        visits={[
          visit({ ticket: 'A020', actions: ['call', 'no_show'] }),
          visit({ ticket: 'A021', status: 'called', actions: ['start', 'recall', 'no_show'] }),
        ]}
        onAction={vi.fn()}
      />,
    );
    const filled = (name: string) =>
      screen.getByRole('button', { name }).className.includes('bg-primary');
    expect(filled('Call A020')).toBe(true);
    expect(filled('Start A021')).toBe(true);
    // Call again is not a button on the row; it waits in the overflow menu.
    expect(screen.queryByRole('button', { name: 'Call again A021' })).toBeNull();
  });

  it('keeps Remove and No-show out of the row until its menu opens, and never beside Call', async () => {
    const row = visit({ ticket: 'A024', actions: ['call', 'no_show', 'remove'] });
    render(<VisitList visits={[row]} onAction={vi.fn()} />);
    const names = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names()).toEqual(['Call A024', 'More actions for A024']);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More actions for A024' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'No-show',
      'Remove',
    ]);
  });

  it('offers recall from the menu and runs it', async () => {
    const onAction = vi.fn();
    const row = visit({ ticket: 'A025', status: 'called', actions: ['start', 'recall'] });
    render(<VisitList visits={[row]} onAction={onAction} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More actions for A025' }));
    await user.click(screen.getByRole('menuitem', { name: 'Call again' }));
    expect(onAction).toHaveBeenCalledWith(row, 'recall');
  });

  it('marks a called row with a status pill and an icon, not colour alone', () => {
    render(
      <VisitList visits={[visit({ ticket: 'A026', status: 'called', actions: ['start'] })]} />,
    );
    const pill = screen.getByText('Called').closest('[data-status]')!;
    expect(pill.getAttribute('data-status')).toBe('called');
    expect(pill.querySelector('svg')).not.toBeNull();
  });

  it('makes "send on" the primary action when a journey step is next, and Done moves to the menu', () => {
    render(
      <VisitList
        visits={[
          visit({
            ticket: 'A023',
            status: 'serving',
            journeyNextQueueId: 'q2',
            actions: ['complete'],
          }),
        ]}
        queues={[{ id: 'q2', name: 'Colour' } as ConsoleQueue]}
        onAction={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Done with A023' })).toBeNull();
    expect(buttons[0]!.className).toContain('bg-primary');
    expect(buttons[1]!.getAttribute('aria-label')).toBe('More actions for A023');
  });

  it('puts details and history in the overflow menu, leaving the main action alone', async () => {
    render(
      <VisitList
        visits={[visit({ ticket: 'A022', actions: ['call'] })]}
        onAction={vi.fn()}
        onSaveNotes={vi.fn()}
        timeZone="UTC"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Details for A022' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Call A022' }).className).toContain('bg-primary');
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions for A022' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Details',
      'History',
    ]);
  });

  it('opens the no-show confirmation when a keyboard shortcut asks for it, then clears the request', () => {
    const row = visit({ ticket: 'A027', actions: ['call', 'no_show'] });
    const cleared = vi.fn();
    render(
      <VisitList
        visits={[row]}
        onAction={vi.fn()}
        confirmRequest={{ id: row.id, action: 'no_show' }}
        onConfirmRequest={cleared}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Mark A027 as a no-show?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(cleared).toHaveBeenCalled();
  });
});

describe('mainAction', () => {
  it('follows the order a visit moves through the day', () => {
    expect(mainAction(['recall', 'requeue', 'call'])).toBe('call');
    expect(mainAction(['recall', 'start'])).toBe('start');
    expect(mainAction(['check_in', 'call'])).toBe('check_in');
    expect(mainAction(['complete'])).toBe('complete');
    expect(mainAction(['reinstate'])).toBe('reinstate');
  });

  it('is none when nothing primary is allowed, or when a journey step takes its place', () => {
    expect(mainAction([])).toBeNull();
    expect(mainAction(['cancel', 'remove'])).toBeNull();
    expect(mainAction(['complete'], true)).toBeNull();
  });
});

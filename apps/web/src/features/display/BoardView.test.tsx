import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { BoardView } from './BoardView.tsx';
import { HIGHLIGHT_MS } from './highlight.ts';

beforeAll(() => loadNamespaces('display'));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const snapshot = (over: { names?: boolean; called?: string[] } = {}) => ({
  location_id: 'l',
  location_name: 'Main Street',
  names_enabled: over.names ?? false,
  as_of: '2026-10-25T10:00:00Z',
  queues: [
    {
      id: 'q1',
      name: 'Walk-ins',
      state: 'open' as const,
      now_serving: (over.called ?? ['A001']).map((ticket, i) => ({
        display_ticket: ticket,
        counter_label: 'Chair 2',
        first_name: over.names ? 'Dana' : null,
        called_at: `2026-10-25T09:5${i}:00Z`,
      })),
      next_up: [{ display_ticket: 'A003', counter_label: null, first_name: null, called_at: null }],
    },
  ],
});

describe('BoardView', () => {
  it('shows now serving with its counter and next up per queue', () => {
    render(<BoardView snapshot={snapshot()} timeZone="Asia/Kolkata" />);
    const queue = screen.getByRole('region', { name: 'Walk-ins' });
    expect(within(queue).getByTestId('now-serving').textContent).toContain('A001');
    expect(within(queue).getByTestId('now-serving').textContent).toContain('Chair 2');
    expect(within(queue).getByTestId('next-up').textContent).toContain('A003');
    // as_of is 10:00Z: shown in the location's zone (UTC+5:30), whatever the device's is.
    expect(screen.getByText(/Updated/).textContent).toMatch(/\b(15|03):30\b/);
  });

  it('renders first names only when the location turned names on', () => {
    const { rerender } = render(
      <BoardView snapshot={{ ...snapshot({ names: true }), names_enabled: false }} />,
    );
    expect(screen.queryByText('Dana')).toBeNull();
    rerender(<BoardView snapshot={snapshot({ names: true })} />);
    expect(screen.getByText('Dana')).toBeTruthy();
  });

  it('highlights a new call, not the calls on screen at load, and lets it fade', () => {
    vi.useFakeTimers();
    const { rerender } = render(<BoardView snapshot={snapshot({ called: ['A001'] })} />);
    const item = (ticket: string) => screen.getByText(ticket).closest('li')!;
    expect(item('A001').dataset.highlight).toBe('false');

    rerender(<BoardView snapshot={snapshot({ called: ['A001', 'A002'] })} />);
    expect(item('A002').dataset.highlight).toBe('true');
    expect(item('A001').dataset.highlight).toBe('false');
    // The ring is colour; the label says it in words for anyone who can't tell the colour.
    expect(within(item('A002')).getByText('Called')).toBeTruthy();
    expect(within(item('A001')).queryByText('Called')).toBeNull();

    act(() => vi.advanceTimersByTime(HIGHLIGHT_MS + 1_000));
    expect(item('A002').dataset.highlight).toBe('false');
  });
});

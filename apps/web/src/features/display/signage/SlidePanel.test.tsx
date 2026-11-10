import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { BoardView } from '../BoardView.tsx';
import { HIGHLIGHT_MS } from '../highlight.ts';
import type { DisplaySlide } from './api.ts';
import { SlidePanel } from './SlidePanel.tsx';
import { useSlideRotation } from './useSlideRotation.ts';

beforeAll(() => loadNamespaces('display'));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const slides: DisplaySlide[] = [
  { kind: 'text', imageUrl: null, body: 'Free coffee', durationS: 5 },
  { kind: 'text', imageUrl: null, body: 'Loyalty card', durationS: 8 },
];

describe('useSlideRotation', () => {
  it('moves on after each slide`s own duration and wraps', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSlideRotation([5, 8], false));
    expect(result.current).toBe(0);
    act(() => void vi.advanceTimersByTime(4_999));
    expect(result.current).toBe(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(1);
    act(() => void vi.advanceTimersByTime(8_000));
    expect(result.current).toBe(0);
  });

  it('holds still while paused and gives the slide its full time after', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ paused }) => useSlideRotation([5, 8], paused), {
      initialProps: { paused: false },
    });
    act(() => void vi.advanceTimersByTime(4_000));
    rerender({ paused: true });
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(0);
    rerender({ paused: false });
    act(() => void vi.advanceTimersByTime(4_999));
    expect(result.current).toBe(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(1);
  });

  it('stays on a single slide and starts over when the list shrinks', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ d }) => useSlideRotation(d, false), {
      initialProps: { d: [5, 5, 5] },
    });
    act(() => void vi.advanceTimersByTime(5_000));
    act(() => void vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(2);
    rerender({ d: [5] });
    expect(result.current).toBe(0);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(0);
  });
});

const snapshot = (called: string[]) => ({
  location_id: 'l',
  location_name: 'Main Street',
  names_enabled: false,
  as_of: '2026-10-25T10:00:00Z',
  queues: [
    {
      id: 'q1',
      name: 'Walk-ins',
      state: 'open' as const,
      now_serving: called.map((ticket, i) => ({
        display_ticket: ticket,
        counter_label: 'Chair 2',
        first_name: null,
        called_at: `2026-10-25T09:5${i}:00Z`,
      })),
      next_up: [],
    },
  ],
});

describe('SlidePanel on the board', () => {
  const board = (called: string[]) => (
    <BoardView
      snapshot={snapshot(called)}
      panel={(calls) => <SlidePanel slides={slides} calls={calls} />}
    />
  );

  it('AC1: a call takes over the slide area at once, the now-serving list stays, the slide returns after', () => {
    vi.useFakeTimers();
    const { rerender } = render(board(['A001']));
    expect(screen.getByTestId('slide-panel').textContent).toContain('Free coffee');
    expect(screen.queryByTestId('call-takeover')).toBeNull();

    rerender(board(['A001', 'A002']));
    const takeover = screen.getByTestId('call-takeover');
    expect(takeover.textContent).toContain('A002');
    expect(takeover.textContent).toContain('Chair 2');
    expect(takeover.textContent).not.toContain('A001'); // only the new call
    expect(screen.queryByTestId('slide-panel')).toBeNull();
    // The board itself is still there, with both tickets, and the panel is not inside it.
    const serving = screen.getByTestId('now-serving');
    expect(serving.textContent).toContain('A001');
    expect(serving.textContent).toContain('A002');
    expect(serving.contains(takeover)).toBe(false);

    act(() => void vi.advanceTimersByTime(HIGHLIGHT_MS + 1_000));
    expect(screen.queryByTestId('call-takeover')).toBeNull();
    expect(screen.getByTestId('slide-panel').textContent).toContain('Free coffee');
  });

  it('shows nothing without slides', () => {
    render(
      <BoardView
        snapshot={snapshot(['A001'])}
        panel={(c) => <SlidePanel slides={[]} calls={c} />}
      />,
    );
    expect(screen.queryByTestId('slide-panel')).toBeNull();
  });

  it('renders slide text as literal text', () => {
    const evil: DisplaySlide = {
      kind: 'text',
      imageUrl: null,
      body: '<img src=x onerror=alert(1)>',
      durationS: 5,
    };
    const { container } = render(<SlidePanel slides={[evil]} calls={[]} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });
});

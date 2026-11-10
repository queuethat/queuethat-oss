import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button.tsx';
import { ToastProvider, useToast } from './Toast.tsx';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Removes({ onUndo }: { onUndo: () => void }) {
  const toast = useToast();
  return (
    <>
      <Button onClick={() => toast.undo('A012 removed', onUndo)}>Remove</Button>
      <Button onClick={() => toast.show({ message: 'Server unreachable', tone: 'danger' })}>
        Fail
      </Button>
    </>
  );
}

function setup() {
  const onUndo = vi.fn();
  render(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
      <Removes onUndo={onUndo} />
    </ToastProvider>,
  );
  return { user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }), onUndo };
}

describe('UndoToast', () => {
  it('announces the message in a live region with an Undo action', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    const polite = region.querySelector('[aria-live="polite"]');
    expect(polite?.textContent).toContain('A012 removed');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('announces error toasts as alerts', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Fail' }));
    expect(screen.getByRole('alert').textContent).toContain('Server unreachable');
  });

  it('runs onUndo exactly once and closes', async () => {
    const { user, onUndo } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('A012 removed')).toBeNull();
  });

  it('expires after 10 s without undoing', async () => {
    const { user, onUndo } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    act(() => vi.advanceTimersByTime(9_000));
    expect(screen.getByText('A012 removed')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.queryByText('A012 removed')).toBeNull();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('does not expire while the pointer is over it', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.hover(screen.getByText('A012 removed'));
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText('A012 removed')).toBeTruthy();
  });

  it('keeps earlier timers when another toast arrives', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    act(() => vi.advanceTimersByTime(6_000));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    act(() => vi.advanceTimersByTime(4_500));
    expect(screen.getAllByText('A012 removed')).toHaveLength(1);
  });
});

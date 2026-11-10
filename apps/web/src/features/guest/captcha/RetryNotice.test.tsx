import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryNotice } from './RetryNotice.tsx';

vi.mock('../../../lib/translation.tsx', () => ({
  useTranslation: () => ({ t: (key: string, o?: { count: number }) => `${key}:${o?.count}` }),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RetryNotice', () => {
  it('is a polite live region that counts the minutes down and then calls onDone', () => {
    const onDone = vi.fn();
    render(<RetryNotice until={Date.now() + 90_000} onDone={onDone} />);
    const note = screen.getByRole('status');
    expect(note.getAttribute('aria-live')).toBe('polite');
    expect(note.textContent).toBe('join.retryIn:2');
    act(() => void vi.advanceTimersByTime(40_000));
    expect(screen.getByRole('status').textContent).toBe('join.retryIn:1');
    act(() => void vi.advanceTimersByTime(60_000));
    expect(onDone).toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

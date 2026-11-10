import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { ConsoleHints } from './ConsoleHints.tsx';
import { resetHintsForTest } from './store.ts';

beforeAll(() => loadNamespaces('console-hints'));
beforeEach(() => {
  localStorage.clear();
  resetHintsForTest();
});
afterEach(cleanup);

describe('ConsoleHints', () => {
  it('shows the three hints on first open, without taking focus', () => {
    render(<ConsoleHints />);
    expect(screen.getByText('Call next.')).toBeTruthy();
    expect(screen.getByText('Undo.')).toBeTruthy();
    expect(screen.getByText('Shortcuts.')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('dismisses one hint at a time and remembers it on this browser', async () => {
    const { unmount } = render(<ConsoleHints />);
    await userEvent.click(screen.getByRole('button', { name: 'Got it', description: /^Undo\./ }));
    expect(screen.queryByText('Undo.')).toBeNull();
    expect(screen.getByText('Call next.')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('qm.console.hints') ?? '[]')).toEqual(['undo']);
    unmount();
    render(<ConsoleHints />);
    expect(screen.queryByText('Undo.')).toBeNull();
    expect(screen.getByText('Shortcuts.')).toBeTruthy();
  });

  it('dismisses everything at once and then renders nothing', async () => {
    const { container } = render(<ConsoleHints />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss all hints' }));
    expect(container.innerHTML).toBe('');
    resetHintsForTest();
    const again = render(<ConsoleHints />);
    expect(again.container.innerHTML).toBe('');
  });

  it('still hides a dismissed hint when storage is unavailable', async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('blocked');
    };
    try {
      render(<ConsoleHints />);
      await userEvent.click(
        screen.getByRole('button', { name: 'Got it', description: /^Shortcuts\./ }),
      );
      expect(screen.queryByText('Shortcuts.')).toBeNull();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

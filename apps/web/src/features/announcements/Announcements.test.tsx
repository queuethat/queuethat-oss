import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Announcements } from './Announcements.tsx';
import { dismissedKey } from './dismissed.ts';

const state = vi.hoisted(() => ({
  userId: 'user-1' as string | null,
  announcements: [] as {
    id: string;
    severity: 'info' | 'warning' | 'maintenance';
    message: string;
  }[],
}));

vi.mock('../auth/api.ts', () => ({
  useSession: () => ({ data: state.userId ? { user: { id: state.userId } } : null }),
}));
vi.mock('./api.ts', () => ({
  useActiveAnnouncements: () => ({ data: state.announcements }),
}));

beforeEach(() => {
  window.localStorage.clear();
  state.userId = 'user-1';
  state.announcements = [
    { id: 'm1', severity: 'maintenance', message: 'Down Sunday 2am' },
    { id: 'i1', severity: 'info', message: 'New reports page' },
  ];
});
afterEach(cleanup);

const banners = () => screen.queryAllByRole('status').map((b) => b.dataset.severity);

describe('Announcements', () => {
  it('shows every active announcement, with dismiss only on info', () => {
    render(<Announcements />);
    expect(banners()).toEqual(['maintenance', 'info']);
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  });

  it('remembers a dismissed info announcement per user', () => {
    const { unmount } = render(<Announcements />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })));
    expect(banners()).toEqual(['maintenance']);
    unmount();

    render(<Announcements />);
    expect(banners()).toEqual(['maintenance']);
    cleanup();

    state.userId = 'user-2';
    render(<Announcements />);
    expect(banners()).toEqual(['maintenance', 'info']);
  });

  it('forgets dismissals of announcements that are no longer active', () => {
    window.localStorage.setItem(dismissedKey('user-1'), JSON.stringify(['gone']));
    render(<Announcements />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })));
    expect(JSON.parse(window.localStorage.getItem(dismissedKey('user-1')) ?? '')).toEqual(['i1']);
  });

  it('still shows announcements when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<Announcements />);
    expect(banners()).toEqual(['maintenance', 'info']);
    vi.restoreAllMocks();
  });

  it('renders nothing when signed out', () => {
    state.userId = null;
    render(<Announcements />);
    expect(banners()).toEqual([]);
  });
});

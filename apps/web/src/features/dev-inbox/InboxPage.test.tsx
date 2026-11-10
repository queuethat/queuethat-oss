import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { InboxPage } from './InboxPage.tsx';
import { groupThreads } from './threads.ts';

const m = vi.hoisted(() => ({ mutate: vi.fn(), threads: { current: [] as unknown[] } }));
vi.mock('../auth/current.ts', () => ({ useCurrentOrg: () => ({ id: 'org-1', role: 'admin' }) }));
vi.mock('./api.ts', () => ({
  useDevInbox: () => ({ data: m.threads.current, isPending: false }),
  useSendReply: () => ({
    mutate: m.mutate,
    isPending: false,
    isError: false,
    isSuccess: false,
    data: undefined,
    error: null,
  }),
}));

beforeAll(() => loadNamespaces('dev-inbox'));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const out = (id: number, recipient: string, at: string, body = 'Your turn') => ({
  id,
  recipient,
  body,
  segments: 1,
  status: 'sent',
  at,
});

describe('groupThreads', () => {
  it('makes one thread per number, oldest message first, newest thread first', () => {
    const threads = groupThreads(
      [
        out(1, '+14155550101', '2026-10-30T10:00:00Z'),
        out(2, '+14155550102', '2026-10-30T10:05:00Z'),
        out(3, '+14155550101', '2026-10-30T10:10:00Z', 'Almost up'),
      ],
      [{ id: 1, from: '+14155550102', body: 'STOP', at: '2026-10-30T10:06:00Z' }],
    );
    expect(threads.map((t) => t.number)).toEqual(['+14155550101', '+14155550102']);
    expect(threads[1]!.messages.map((x) => x.body)).toEqual(['Your turn', 'STOP']);
    expect(threads[0]!.messages.map((x) => x.direction)).toEqual(['out', 'out']);
  });
});

describe('InboxPage', () => {
  it('says so when there are no messages', () => {
    render(<InboxPage />);
    expect(screen.getByText(/No messages yet/)).toBeTruthy();
  });

  it('shows each conversation with its segments and status, and replies as that number', async () => {
    m.threads.current = groupThreads([out(1, '+14155550101', '2026-10-30T10:00:00Z')], []);
    render(<InboxPage />);
    expect(screen.getByRole('region', { name: 'Conversation with +14155550101' })).toBeTruthy();
    expect(screen.getByText('1 segment')).toBeTruthy();
    expect(screen.getByText('sent')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reply as +14155550101'), { target: { value: 'STOP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() =>
      expect(m.mutate).toHaveBeenCalledWith(
        { from: '+14155550101', body: 'STOP' },
        expect.any(Object),
      ),
    );
  });
});

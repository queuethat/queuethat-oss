import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../../lib/i18n.ts';
import type { GuestNotice } from './api.ts';
import { GuestNoticePanel } from './GuestNoticePanel.tsx';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  locations: [
    { id: 'loc-1', name: 'Downtown' },
    { id: 'loc-2', name: 'Uptown' },
  ],
}));
vi.mock('../../../../../lib/supabase.ts', () => ({
  supabase: {
    rpc: m.rpc,
    schema: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({ order: () => Promise.resolve({ data: m.locations, error: null }) }),
        }),
      }),
    }),
  },
}));

const notice = (over: Partial<GuestNotice>): GuestNotice => ({
  id: 'n1',
  log_id: 'log-1',
  subject: 'Please read',
  body: 'We found a problem.',
  window_from: '2026-11-01T00:00:00Z',
  window_to: '2026-11-03T00:00:00Z',
  location_id: null,
  status: 'draft',
  approved_at: null,
  sent_at: null,
  recipient_count: 12,
  updated_at: '2026-11-09T00:00:00Z',
  ...over,
});

function setup(rows: GuestNotice[], isOwner: boolean) {
  m.rpc.mockImplementation((name: string) =>
    Promise.resolve({ data: name === 'list_guest_notices' ? rows : null, error: null }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <GuestNoticePanel logId="log-1" orgId="org-1" isOwner={isOwner} />
    </QueryClientProvider>,
  );
}

beforeAll(() => loadNamespaces('admin-privacy'));
beforeEach(() => m.rpc.mockReset());
afterEach(cleanup);

describe('GuestNoticePanel', () => {
  it('lets an owner approve a draft and shows only a count', async () => {
    setup([notice({})], true);
    expect(await screen.findByTestId('guest-notice-status')).toHaveProperty(
      'textContent',
      'Draft. It would reach 12 guests. An owner has to approve it.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(m.rpc).toHaveBeenCalledWith('approve_guest_notice', { p_id: 'n1' }));
  });

  it('offers send only once approved, behind a confirmation', async () => {
    setup([notice({ status: 'approved' })], true);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Send to guests' }));
    expect(m.rpc).not.toHaveBeenCalledWith('send_guest_notice', expect.anything());
    await userEvent.click(await screen.findByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(m.rpc).toHaveBeenCalledWith('send_guest_notice', { p_id: 'n1' }));
  });

  it('shows an admin who is not an owner no approve or send', async () => {
    setup([notice({})], false);
    expect(await screen.findByText('Only an owner can approve and send.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('reports a sent notice with its recipient count', async () => {
    setup([notice({ status: 'sent', recipient_count: 7, sent_at: '2026-11-09T01:00:00Z' })], true);
    expect(await screen.findByTestId('guest-notice-sent')).toHaveProperty(
      'textContent',
      'Sent to 7 guests.',
    );
  });

  it('saves the notice for one location when the business picks one', async () => {
    setup([], true);
    await userEvent.type(await screen.findByLabelText('Subject'), 'Please read');
    await userEvent.type(screen.getByLabelText('Message to guests'), 'We found a problem.');
    await userEvent.type(screen.getByLabelText('Guests who visited or booked from'), '2026-11-01');
    await userEvent.type(screen.getByLabelText('to (inclusive)'), '2026-11-02');
    await userEvent.selectOptions(await screen.findByLabelText('Location'), 'loc-2');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith(
        'save_guest_notice',
        expect.objectContaining({ p_log_id: 'log-1', p_location_id: 'loc-2' }),
      ),
    );
  });

  it('defaults to all locations and offers no filter for a single location', async () => {
    setup([], true);
    const select = await screen.findByLabelText('Location');
    expect((select as HTMLSelectElement).value).toBe('');
    expect(screen.getByRole('option', { name: 'All locations' })).toBeTruthy();
    cleanup();
    m.locations = [{ id: 'loc-1', name: 'Downtown' }];
    setup([], true);
    await screen.findByLabelText('Subject');
    expect(screen.queryByLabelText('Location')).toBeNull();
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { RecentTexts } from './RecentTexts.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

beforeAll(() => loadNamespaces('staff'));
beforeEach(() => m.rpc.mockReset());
afterEach(cleanup);

const row = (over: Record<string, unknown>) => ({
  id: 'n1',
  created_at: '2026-11-12T15:04:00Z',
  template: 'called',
  outcome: 'delivered',
  reason: null,
  number_hint: '23',
  ticket: 'A12',
  ...over,
});

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecentTexts locationId="loc-1" tz="America/Winnipeg" />
    </QueryClientProvider>,
  );
}

describe('RecentTexts', () => {
  it('shows each text with its outcome, masked number and ticket, and explains the ones that did not arrive', async () => {
    m.rpc.mockResolvedValue({
      data: [
        row({}),
        row({ id: 'n2', outcome: 'blocked_stop', reason: 'suppressed', template: 'almost_up' }),
        row({ id: 'n3', outcome: 'quiet_hours', template: 'broadcast_marketing' }),
      ],
      error: null,
    });
    view();
    const items = await screen.findAllByTestId('recent-text');
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain('Delivered');
    expect(items[0]?.textContent).toContain("It's your turn");
    expect(items[0]?.textContent).toContain('Number ending 23');
    expect(items[0]?.textContent).toContain('Ticket A12');
    expect(within(items[1]!).getByText(/replied STOP, so we can't text them/)).toBeTruthy();
    expect(items[2]?.textContent).toContain('Other message');
    expect(items[2]?.textContent).toContain('when your sending hours start');
    expect(m.rpc).toHaveBeenCalledWith('list_recent_texts', { p_location_id: 'loc-1' });
  });

  it('pages to older texts from the last one shown', async () => {
    const page = Array.from({ length: 50 }, (_, i) =>
      row({ id: `n${i}`, created_at: `2026-11-12T10:${String(59 - i).padStart(2, '0')}:00Z` }),
    );
    m.rpc
      .mockResolvedValueOnce({ data: page, error: null })
      .mockResolvedValueOnce({ data: [row({ id: 'old' })], error: null });
    view();
    await userEvent.click(await screen.findByRole('button', { name: 'Show older texts' }));
    expect(m.rpc).toHaveBeenLastCalledWith('list_recent_texts', {
      p_location_id: 'loc-1',
      p_before: '2026-11-12T10:10:00Z',
    });
    expect(await screen.findAllByTestId('recent-text')).toHaveLength(51);
  });

  it('says when there are none, and when loading fails', async () => {
    m.rpc.mockResolvedValueOnce({ data: [], error: null });
    view();
    expect(await screen.findByText('No texts in the last 7 days.')).toBeTruthy();
    cleanup();
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'not_found' } });
    view();
    expect(await screen.findByText(/Couldn't load texts/)).toBeTruthy();
  });
});

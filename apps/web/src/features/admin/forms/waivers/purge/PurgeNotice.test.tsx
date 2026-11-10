import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../../lib/i18n.ts';
import { PurgeNotice } from './PurgeNotice.tsx';

vi.mock('../../../../auth/current.ts', () => ({
  useCurrentLocation: () => ({ location: { id: 'l1', name: 'Main', tz: 'America/Phoenix' } }),
}));
const rpc = vi.fn();
let expiring = 2;
vi.mock('../../../../../lib/supabase.ts', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    schema: () => ({
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = (_cols: string, opts?: { head?: boolean }) =>
          opts?.head ? { lt: () => Promise.resolve({ count: expiring, error: null }) } : chain;
        for (const m of ['eq', 'lt', 'order', 'limit']) chain[m] = () => chain;
        chain.single = () =>
          Promise.resolve({
            data: { accepted_at: '2026-01-05T12:00:00Z', waiver_retention_days: 365 },
            error: null,
          });
        return chain;
      },
    }),
  },
}));

beforeAll(() => loadNamespaces('admin-forms', 'common'));
afterEach(cleanup);

const setup = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PurgeNotice orgId="o1" locationId="l1" />
    </QueryClientProvider>,
  );

describe('PurgeNotice', () => {
  it('warns and exports the expiring records in one click', async () => {
    expiring = 2;
    rpc.mockResolvedValue({
      error: null,
      data: { timezone: 'America/Phoenix', truncated: false, rows: [] },
    });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
    setup();
    expect(await screen.findByText('2 waiver records will be deleted within 30 days')).toBeTruthy();
    expect(screen.getByText(/oldest was agreed on 2026-01-05/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Download these records' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'export_waiver_records',
        expect.objectContaining({ p_location_id: 'l1', p_from: '2026-01-05' }),
      ),
    );
  });

  it('says nothing when no record is due', async () => {
    expiring = 0;
    setup();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('waiver-purge-notice')).toBeNull();
  });
});

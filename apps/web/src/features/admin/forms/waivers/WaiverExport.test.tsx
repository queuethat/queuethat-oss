import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { WaiverExport } from './WaiverExport.tsx';

vi.mock('../../../auth/current.ts', () => ({
  useCurrentLocation: () => ({ location: { id: 'l1', name: 'Main', tz: 'America/Phoenix' } }),
  useCurrentOrg: () => undefined,
}));
const rpc = vi.fn();
vi.mock('../../../../lib/supabase.ts', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));

beforeAll(() => loadNamespaces('admin-forms', 'common'));
afterEach(cleanup);

const setup = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WaiverExport />
    </QueryClientProvider>,
  );

describe('WaiverExport', () => {
  it('loads the range through the logged RPC and lists the records', async () => {
    rpc.mockResolvedValue({
      error: null,
      data: {
        timezone: 'America/Phoenix',
        truncated: false,
        rows: [
          {
            accepted_at: '2026-11-09T16:42:00Z',
            signed_at: null,
            form_name: 'Studio',
            form_version: 3,
            agreement: 'Waiver',
            text_hash: 'a'.repeat(64),
            typed_name: 'Ann Lee',
            guardian_name: null,
            guest_name: 'Ann',
            subject_kind: 'visit',
          },
        ],
      },
    });
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Show records' }));
    expect(await screen.findByText('1 record')).toBeTruthy();
    expect(screen.getByText('2026-11-09 09:42')).toBeTruthy();
    expect(screen.getByText('Ann Lee')).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith(
      'export_waiver_records',
      expect.objectContaining({ p_location_id: 'l1' }),
    );
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeTruthy();
  });

  it('shows a refusal', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission_denied' } });
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Show records' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).not.toBe(''));
  });
});

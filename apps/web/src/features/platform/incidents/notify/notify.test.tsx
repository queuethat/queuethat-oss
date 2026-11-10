import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { NoticePanel } from './NoticePanel.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

const notice = (over: Record<string, unknown>) => ({
  id: 'n1',
  incident_id: 'i1',
  subject: 'Security incident',
  body: 'Tokens leaked.',
  status: 'draft',
  approved_at: null,
  sent_at: null,
  org_count: 0,
  acknowledged_count: 0,
  updated_at: '2026-11-09T00:00:00Z',
  ...over,
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NoticePanel incidentId="i1" />
    </QueryClientProvider>,
  );
}

const listing = (rows: unknown[]) =>
  m.rpc.mockImplementation((fn: string) =>
    Promise.resolve({ data: fn === 'platform_list_notices' ? rows : null, error: null }),
  );

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => m.rpc.mockReset());
afterEach(cleanup);

describe('NoticePanel', () => {
  it('offers a draft first, never a send', async () => {
    listing([]);
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Draft a notice' }));
    expect(m.rpc).toHaveBeenCalledWith('platform_save_notice', {
      p_incident_id: 'i1',
      p_subject: undefined,
      p_body: undefined,
    });
    expect(screen.queryByRole('button', { name: /Send to affected/ })).toBeNull();
  });

  it('approves a draft, and offers sending only once approved', async () => {
    listing([notice({})]);
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_approve_notice', { p_id: 'n1' }),
    );
    expect(screen.queryByRole('button', { name: /Send to affected/ })).toBeNull();
  });

  it('sends an approved notice only after the confirmation', async () => {
    listing([notice({ status: 'approved' })]);
    setup();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Send to affected businesses' }),
    );
    expect(m.rpc).not.toHaveBeenCalledWith('platform_send_notice', expect.anything());
    await userEvent.click(await screen.findByRole('button', { name: 'Send notice' }));
    await waitFor(() => expect(m.rpc).toHaveBeenCalledWith('platform_send_notice', { p_id: 'n1' }));
  });

  it('shows how many businesses acknowledged a sent notice', async () => {
    listing([notice({ status: 'sent', org_count: 3, acknowledged_count: 2 })]);
    setup();
    expect((await screen.findByTestId('notice-sent')).textContent).toContain(
      '3 businesses; 2 have confirmed',
    );
  });
});

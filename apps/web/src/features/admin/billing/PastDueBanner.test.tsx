import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { PastDueBanner } from './PastDueBanner.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn(), role: 'owner' }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../../auth/current.ts', () => ({
  useCurrentOrg: () => ({ id: 'org-a', role: m.role }),
}));
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

const billing = (over: Record<string, unknown> = {}) => ({
  data: [
    {
      enabled: true,
      plan_id: 'standard',
      plan_name: 'Standard',
      unit_price_minor: 1900,
      currency: 'usd',
      locations: 1,
      subscribed: true,
      status: 'past_due',
      current_period_end: null,
      grace_ends_at: '2026-12-15T12:00:00Z',
      ...over,
    },
  ],
  error: null,
});

const view = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PastDueBanner />
    </QueryClientProvider>,
  );

beforeAll(() => loadNamespaces('common'));
beforeEach(() => {
  m.role = 'owner';
  m.rpc.mockReset();
});
afterEach(cleanup);

describe('PastDueBanner', () => {
  it('shows the owner when paid features end, with a link to billing', async () => {
    m.rpc.mockResolvedValue(billing());
    view();
    const banner = await screen.findByTestId('past-due-banner');
    expect(banner.textContent).toMatch(/Paid features end on Dec 15, 2026/);
    expect(
      screen.getByRole('link', { name: /update your payment method/i }).getAttribute('href'),
    ).toBe('/admin/billing');
  });

  it('says so when the subscription is unpaid', async () => {
    m.rpc.mockResolvedValue(billing({ status: 'unpaid', grace_ends_at: null }));
    view();
    expect((await screen.findByTestId('past-due-banner')).textContent).toMatch(/unpaid/i);
  });

  it('stays hidden for a healthy subscription', async () => {
    m.rpc.mockResolvedValue(billing({ status: 'active', grace_ends_at: null }));
    view();
    await waitFor(() => expect(m.rpc).toHaveBeenCalled());
    expect(screen.queryByTestId('past-due-banner')).toBeNull();
  });

  it('stays hidden while billing is off', async () => {
    m.rpc.mockResolvedValue(billing({ enabled: false }));
    view();
    await waitFor(() => expect(m.rpc).toHaveBeenCalled());
    expect(screen.queryByTestId('past-due-banner')).toBeNull();
  });

  it('stays hidden for everyone but the owner, and never asks the database', () => {
    m.role = 'admin';
    m.rpc.mockResolvedValue(billing());
    view();
    expect(screen.queryByTestId('past-due-banner')).toBeNull();
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

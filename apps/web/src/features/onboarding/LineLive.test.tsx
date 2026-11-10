import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { LineLive } from './LineLive.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../auth/current.ts', () => ({
  useCurrentLocation: () => ({ location: { id: 'loc-a', name: 'Main St', slug: 'main-st' } }),
  useCurrentOrg: () => ({ id: 'org-a', role: 'owner' }),
}));
vi.mock('../admin/poster/JoinQr.tsx', () => ({ JoinQr: () => <div role="img" aria-label="QR" /> }));
vi.mock('../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

const billing = (over: Record<string, unknown>) => ({
  data: [{ enabled: true, paid_channels: false, plans: [], ...over }],
  error: null,
});

const view = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <LineLive created={{ orgId: 'org-a', locationId: 'loc-a' }} />
    </QueryClientProvider>,
  );

beforeAll(() => loadNamespaces('onboarding'));
beforeEach(() => m.rpc.mockReset());
afterEach(cleanup);

describe('LineLive guest alerts', () => {
  it('tells a free org that texts need a paid plan', async () => {
    m.rpc.mockResolvedValue(billing({ paid_channels: false }));
    view();
    const block = screen.getByTestId('guest-alerts');
    expect(block.textContent).toMatch(/browser alert/i);
    expect(block.textContent).toMatch(/Add to Home Screen/i);
    expect(block.textContent).toMatch(/TV/);
    expect(await screen.findByText(/not sent on your current plan/i)).toBeTruthy();
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('org_billing', { p_org_id: 'org-a' });
  });

  it('changes the wording when the plan allows SMS', async () => {
    m.rpc.mockResolvedValue(billing({ paid_channels: true }));
    view();
    expect(await screen.findByText(/can also send text messages/i)).toBeTruthy();
    expect(screen.queryByText(/not sent on your current plan/i)).toBeNull();
  });

  it('says nothing about plans while billing is off', async () => {
    m.rpc.mockResolvedValue(billing({ enabled: false }));
    view();
    await vi.waitFor(() => expect(m.rpc).toHaveBeenCalled());
    expect(screen.getByTestId('guest-alerts').textContent).not.toMatch(/text messages/i);
  });

  it('has no accessibility violations', async () => {
    m.rpc.mockResolvedValue(billing({ paid_channels: true }));
    const { container } = view();
    await screen.findByText(/can also send text messages/i);
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});

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
  it('lists the alerts a guest can get without asking the server about plans', () => {
    view();
    const block = screen.getByTestId('guest-alerts');
    expect(block.textContent).toMatch(/browser alert/i);
    expect(block.textContent).toMatch(/Add to Home Screen/i);
    expect(block.textContent).toMatch(/TV/);
    expect(block.textContent).not.toMatch(/plan/i);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = view();
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});

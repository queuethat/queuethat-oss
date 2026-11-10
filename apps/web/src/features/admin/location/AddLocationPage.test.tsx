import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { AddLocationPage } from './AddLocationPage.tsx';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  role: 'owner',
  navigate: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => m.navigate,
}));
vi.mock('../../auth/current.ts', () => ({
  useCurrentOrg: () => ({ id: 'org-a', role: m.role }),
  selectLocation: m.select,
}));
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

beforeAll(() => loadNamespaces('admin', 'admin-billing'));
beforeEach(() => {
  m.role = 'owner';
  m.rpc.mockReset();
  m.navigate.mockReset();
  m.select.mockReset();
});
afterEach(cleanup);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddLocationPage />
    </QueryClientProvider>,
  );
}

describe('AddLocationPage', () => {
  it('adds a location, makes it current and opens its settings', async () => {
    m.rpc.mockResolvedValue({ data: { location_id: 'loc-2', slug: 'elm-street' }, error: null });
    renderPage();
    await userEvent.type(screen.getByLabelText(/location name/i), 'Elm Street');
    await userEvent.click(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith({ to: '/admin/location' }));
    expect(m.rpc).toHaveBeenCalledWith('create_location', {
      p_org_id: 'org-a',
      p_name: 'Elm Street',
      p_tz: expect.any(String),
      p_slug: undefined,
    });
    expect(m.select).toHaveBeenCalledWith('loc-2');
  });

  it('turns plan_limit_reached into a plan message with an upgrade link for the owner', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'plan_limit_reached' },
    });
    renderPage();
    await userEvent.type(screen.getByLabelText(/location name/i), 'Second');
    await userEvent.click(screen.getByRole('button', { name: 'Add location' }));
    expect(await screen.findByText(/no room for another location/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Upgrade' }).getAttribute('href')).toBe(
      '/admin/billing',
    );
    expect(screen.queryByText(/plan_limit_reached/)).toBeNull();
    expect(m.navigate).not.toHaveBeenCalled();
  });

  it('explains a taken slug in words', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'slug_taken' } });
    renderPage();
    await userEvent.type(screen.getByLabelText(/location name/i), 'Second');
    await userEvent.click(screen.getByRole('button', { name: 'Add location' }));
    expect(await screen.findByText(/already used/i)).toBeTruthy();
  });

  it('does not let a manager submit', async () => {
    m.role = 'manager';
    renderPage();
    expect(screen.getByText('Only admins and owners can add a location.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add location' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

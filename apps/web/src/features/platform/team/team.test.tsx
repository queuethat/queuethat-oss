import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { TeamPage } from './TeamPage.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => m.rpc.mockReset());
afterEach(cleanup);

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TeamPage />
    </QueryClientProvider>,
  );
}

const member = {
  user_id: 'u1',
  email: 'riz@example.com',
  role: 'operator',
  mfa_enrolled: true,
  last_sign_in_at: '2026-11-01T09:30:00Z',
  granted_by: null,
  granted_by_email: null,
  granted_at: '2026-08-01T12:00:00Z',
  is_you: true,
};
const agent = {
  ...member,
  user_id: 'u2',
  email: 'agent@example.com',
  role: 'support',
  mfa_enrolled: false,
  last_sign_in_at: null,
  granted_by: 'u1',
  granted_by_email: 'riz@example.com',
  is_you: false,
};

const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole('cell')
    .map((c) => c.textContent);

describe('TeamPage', () => {
  it('lists role, two-step state, last sign-in and who granted it', async () => {
    m.rpc.mockResolvedValue({ data: [member, agent], error: null });
    show();
    const rows = await screen.findAllByTestId('team-member');
    expect(m.rpc).toHaveBeenCalledWith('platform_team');
    expect(cells(rows[0]!)).toEqual([
      'riz@example.comYou',
      'Operator',
      'Set up',
      expect.stringContaining('2026'),
      'Command line',
      expect.stringContaining('2026'),
    ]);
    expect(cells(rows[1]!)).toEqual([
      'agent@example.com',
      'Support',
      'Not set up',
      'Never',
      'riz@example.com',
      expect.stringContaining('2026'),
    ]);
  });

  it('marks only the caller as you', async () => {
    m.rpc.mockResolvedValue({ data: [member, agent], error: null });
    show();
    await screen.findAllByTestId('team-member');
    expect(screen.getAllByText('You')).toHaveLength(1);
  });

  it('is read-only: no button, form or input to grant or revoke', async () => {
    m.rpc.mockResolvedValue({ data: [member, agent], error: null });
    show();
    await screen.findAllByTestId('team-member');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByText(/pnpm platform:revoke/)).toBeTruthy();
    expect(m.rpc.mock.calls.every(([name]) => name === 'platform_team')).toBe(true);
  });

  it('says so when nobody holds a role', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    show();
    expect(await screen.findByText('Nobody holds a platform role.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('tells support (or an operator without MFA) they cannot see it', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission_denied' } });
    show();
    expect(
      await screen.findByText('Only operators with two-step sign-in can see the team.'),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a load error for any other failure', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom' } });
    show();
    expect(await screen.findByText(/Couldn't load this/)).toBeTruthy();
  });

  it('shows a spinner while loading', async () => {
    let finish: (value: unknown) => void = () => {};
    m.rpc.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    show();
    expect(screen.getByText('Loading…')).toBeTruthy();
    finish({ data: [], error: null });
    expect(await screen.findByText('Nobody holds a platform role.')).toBeTruthy();
  });
});

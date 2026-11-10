import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import type { OrgDetail } from '../api.ts';
import { TenantActions, TenantActionsReadOnly } from './TenantActions.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn(), audit: [] as unknown[] }));

vi.mock('../../../lib/supabase.ts', () => {
  const read = () => {
    const result = Promise.resolve({ data: m.audit, error: null });
    const chain: Record<string, unknown> = { then: result.then.bind(result) };
    for (const method of ['select', 'order', 'eq', 'limit', 'gt']) chain[method] = () => chain;
    return chain;
  };
  return { supabase: { rpc: m.rpc, schema: () => ({ from: read }) } };
});

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => {
  m.rpc.mockReset();
  m.rpc.mockResolvedValue({ data: null, error: null });
  m.audit = [{ action: 'org.suspend', reason: 'Abuse reports', at: '2026-10-25T10:00:00Z' }];
});
afterEach(cleanup);

const org = {
  id: 'org-1',
  name: 'Demo Barber',
  slug: 'demo-barber',
  status: 'active',
} as OrgDetail['org'];
const members: OrgDetail['members'] = [
  { user_id: 'u1', email: 'owner@demo.test', role: 'owner', created_at: '2026-10-01T00:00:00Z' },
  { user_id: 'u2', email: 'staff@demo.test', role: 'staff', created_at: '2026-10-02T00:00:00Z' },
];

function show(overrides: Partial<OrgDetail['org']> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TenantActions org={{ ...org, ...overrides }} members={members} />
    </QueryClientProvider>,
  );
}

/** Opens an action's dialog from its row. */
async function open(user: ReturnType<typeof userEvent.setup>, trigger: string) {
  await user.click(screen.getByRole('button', { name: trigger }));
  return screen.findByRole('dialog');
}

describe('TenantActions', () => {
  it('AC1: suspend stays disabled without a reason, and without the slug', async () => {
    const user = userEvent.setup();
    show();
    const dialog = await open(user, 'Suspend business');
    const confirm = within(dialog).getByRole('button', { name: 'Suspend' });
    expect(confirm).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    expect(confirm).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByLabelText('Reason'), '  ');
    expect(confirm).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByLabelText('Reason'), 'Abuse reports');
    expect(confirm).toHaveProperty('disabled', false);
  });

  it('AC3: a wrong slug calls nothing', async () => {
    const user = userEvent.setup();
    show();
    const dialog = await open(user, 'Suspend business');
    await user.type(within(dialog).getByLabelText('Reason'), 'Abuse reports');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barbe');
    const confirm = within(dialog).getByRole('button', { name: 'Suspend' });
    expect(confirm).toHaveProperty('disabled', true);
    await user.click(confirm);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('says what guests see before it suspends, then calls the RPC and shows the audit row', async () => {
    const user = userEvent.setup();
    show();
    const dialog = await open(user, 'Suspend business');
    expect(within(dialog).getByText(/isn't taking guests right now/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Reason'), 'Abuse reports');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_set_org_status', {
        p_org_id: 'org-1',
        p_status: 'suspended',
        p_reason: 'Abuse reports',
      }),
    );
    expect((await screen.findByTestId('result-status')).textContent).toMatch(
      /Recorded: org\.suspend.*Reason: Abuse reports/,
    );
  });

  it('says nothing was recorded when the call changed nothing', async () => {
    const user = userEvent.setup();
    m.audit = [];
    show();
    const dialog = await open(user, 'Suspend business');
    await user.type(within(dialog).getByLabelText('Reason'), 'Abuse reports');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    const result = await screen.findByTestId('result-status');
    expect(result.textContent).toContain('Nothing changed, so nothing new was recorded.');
  });

  it('tells the operator who will read the reason', async () => {
    const user = userEvent.setup();
    show();
    let dialog = await open(user, 'Suspend business');
    expect(within(dialog).getByText(/Shown to the business/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    dialog = await open(user, 'Open break-glass access');
    expect(within(dialog).getByText(/Emailed to every owner/)).toBeTruthy();
  });

  it('offers restore for a suspended business', async () => {
    const user = userEvent.setup();
    show({ status: 'suspended' });
    expect(screen.queryByRole('button', { name: 'Suspend business' })).toBeNull();
    const dialog = await open(user, 'Restore business');
    await user.type(within(dialog).getByLabelText('Reason'), 'Resolved');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_set_org_status', {
        p_org_id: 'org-1',
        p_status: 'active',
        p_reason: 'Resolved',
      }),
    );
  });

  it('transfers to a member other than the owner', async () => {
    const user = userEvent.setup();
    show();
    const dialog = await open(user, 'Transfer ownership');
    expect(within(dialog).getByRole('option', { name: 'staff@demo.test (staff)' })).toBeTruthy();
    expect(within(dialog).queryByRole('option', { name: /owner@demo.test/ })).toBeNull();
    await user.type(within(dialog).getByLabelText('Reason'), 'Owner left');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    await user.click(within(dialog).getByRole('button', { name: 'Transfer' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_transfer_ownership', {
        p_org_id: 'org-1',
        p_new_owner_email: 'staff@demo.test',
        p_reason: 'Owner left',
      }),
    );
  });

  it('warns that the owners are emailed before break-glass', async () => {
    const user = userEvent.setup();
    show();
    const dialog = await open(user, 'Open break-glass access');
    expect(within(dialog).getByText(/Every owner is emailed/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Reason'), 'Legal request 42');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    await user.click(within(dialog).getByRole('button', { name: 'Open access' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_break_glass', {
        p_org_id: 'org-1',
        p_reason: 'Legal request 42',
      }),
    );
  });

  it('says why ownership cannot be transferred when nobody else is a member', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <TenantActions org={org} members={members.slice(0, 1)} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Transfer ownership' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Nobody else is a member/)).toBeTruthy();
  });

  it('uses singular nouns for a count of one', async () => {
    const user = userEvent.setup();
    m.rpc.mockImplementation((name: string) =>
      Promise.resolve({
        data: name === 'platform_sign_out_members' ? { users: 1, sessions: 1 } : { devices: 1 },
        error: null,
      }),
    );
    show();
    let dialog = await open(user, 'Sign everyone out');
    await user.type(within(dialog).getByLabelText('Reason'), 'Compromised');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect((await screen.findByTestId('result-signOut')).textContent).toContain(
      '1 person signed out of 1 session.',
    );
    dialog = await open(user, 'Revoke all screens');
    await user.type(within(dialog).getByLabelText('Reason'), 'Compromised');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke screens' }));
    expect((await screen.findByTestId('result-revokeDevices')).textContent).toContain(
      '1 screen revoked.',
    );
  });

  it('reports how many people and screens were cut off', async () => {
    const user = userEvent.setup();
    m.rpc.mockImplementation((name: string) =>
      Promise.resolve({
        data: name === 'platform_sign_out_members' ? { users: 2, sessions: 3 } : { devices: 4 },
        error: null,
      }),
    );
    show();
    let dialog = await open(user, 'Sign everyone out');
    await user.type(within(dialog).getByLabelText('Reason'), 'Compromised');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect((await screen.findByTestId('result-signOut')).textContent).toContain(
      '2 people signed out of 3 sessions.',
    );
    dialog = await open(user, 'Revoke all screens');
    await user.type(within(dialog).getByLabelText('Reason'), 'Compromised');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke screens' }));
    expect((await screen.findByTestId('result-revokeDevices')).textContent).toContain(
      '4 screens revoked.',
    );
  });

  it('words a refusal and shows no audit row', async () => {
    const user = userEvent.setup();
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission_denied' } });
    show();
    const dialog = await open(user, 'Suspend business');
    await user.type(within(dialog).getByLabelText('Reason'), 'Abuse reports');
    await user.type(within(dialog).getByLabelText(/^Type demo-barber/), 'demo-barber');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .map((a) => a.textContent)
          .join(''),
      ).toBe('Only operators with two-step sign-in can do this.'),
    );
    expect(screen.queryByTestId('result-status')).toBeNull();
  });

  it('offers nothing to change for a business pending deletion', () => {
    show({ status: 'pending_deletion' });
    expect(screen.getByText(/pending deletion/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('TenantActionsReadOnly', () => {
  it('tells a support role that only operators can act', () => {
    render(<TenantActionsReadOnly />);
    expect(screen.getByText(/Only operators can change a business/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

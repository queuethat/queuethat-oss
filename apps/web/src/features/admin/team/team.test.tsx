import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@qm/ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { canManageRole, grantablePresets } from './api.ts';
import { TeamPage } from './TeamPage.tsx';

const m = vi.hoisted(() => ({ role: 'owner' }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/supabase.ts', () => ({
  supabase: { rpc: vi.fn(async () => ({ data: [], error: null })), functions: { invoke } },
}));
vi.mock('../../auth/api.ts', () => ({ useSession: () => ({ data: { user: { id: 'me' } } }) }));
vi.mock('../../auth/current.ts', () => ({
  useCurrentOrg: () => ({ id: 'org', name: 'Org', role: m.role }),
  useCurrentLocation: () => ({ location: undefined, locations: [] }),
}));

beforeAll(() => loadNamespaces('admin-team'));
afterEach(cleanup);

function openInvite(role: string) {
  m.role = role;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
        <TeamPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return screen.findByRole('button', { name: 'Invite someone' }).then((button) => {
    fireEvent.click(button);
    return screen.getByRole('dialog');
  });
}

describe('role ladder behind the presets', () => {
  it('a manager cannot grant any role, an admin cannot grant Owner', () => {
    expect(grantablePresets('manager')).toEqual([]);
    expect(canManageRole('manager', 'owner')).toBe(false);
    expect(grantablePresets('admin').map((p) => p.role)).toEqual(['manager', 'staff']);
    expect(grantablePresets('owner').map((p) => p.role)).toEqual(['owner', 'manager', 'staff']);
  });
});

describe('invite dialog', () => {
  it('asks for an email and one of three presets; the rest is under Advanced', async () => {
    const dialog = await openInvite('owner');
    const presets = within(dialog).getAllByRole('radio');
    expect(presets.map((r) => (r as HTMLInputElement).value)).toEqual([
      'owner',
      'manager',
      'staff',
    ]);
    expect((presets[2] as HTMLInputElement).checked).toBe(true);
    const advanced = dialog.querySelector('details')!;
    expect(advanced.open).toBe(false);
    expect(within(advanced).getByLabelText(/Make this person an Admin/)).toBeTruthy();
    expect(within(advanced).getByLabelText(/All locations/)).toBeTruthy();
  });

  it('an admin is not offered Owner or Admin', async () => {
    const dialog = await openInvite('admin');
    expect(
      within(dialog)
        .getAllByRole('radio')
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(['manager', 'staff']);
    expect(within(dialog).queryByLabelText(/Make this person an Admin/)).toBeNull();
  });

  it('a full team is explained with its limit, not as an unknown error', async () => {
    const response = new Response(JSON.stringify({ error: 'plan_limit_reached', limit: 3 }), {
      status: 402,
    });
    invoke.mockResolvedValue({ data: null, error: { context: response } });
    const dialog = await openInvite('owner');
    fireEvent.change(within(dialog).getByLabelText(/email/i), {
      target: { value: 'new@example.test' },
    });
    fireEvent.submit(within(dialog).getByLabelText(/email/i).closest('form')!);
    expect(
      await within(dialog).findByText('The team is full: it can have 3 members.'),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Something went wrong/)).toBeNull();
  });
});

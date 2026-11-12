import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@qm/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { TeamPage } from '../TeamPage.tsx';

const m = vi.hoisted(() => ({
  role: 'owner',
  scoped: false,
  updates: [] as { table: string; patch: unknown }[],
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  invites: [] as Record<string, unknown>[],
}));

/** A chainable stand-in for the supabase query builder, keyed by table. */
function builder(table: string) {
  const state: { patch?: unknown } = {};
  const result = () => {
    if (state.patch !== undefined) {
      m.updates.push({ table, patch: state.patch });
      return { data: [{ id: 'x' }], error: null };
    }
    if (table === 'organizations') return { data: { scope_staff_to_lines: m.scoped }, error: null };
    if (table === 'memberships') return { data: [{ id: 'mem', queue_ids: null }], error: null };
    return { data: [{ id: 'q1', name: 'Chair 1', ticket_prefix: 'A' }], error: null };
  };
  const chain: Record<string, unknown> = {};
  for (const fn of ['select', 'eq', 'is', 'order', 'single']) chain[fn] = () => chain;
  chain.update = (patch: unknown) => {
    state.patch = patch;
    return chain;
  };
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result());
  return chain;
}

vi.mock('../../../../lib/supabase.ts', () => ({
  supabase: {
    schema: () => ({ from: (table: string) => builder(table) }),
    functions: {
      invoke: vi.fn(async (_name: string, opts: { body: Record<string, unknown> }) => {
        m.invites.push(opts.body);
        return { data: { sent: true }, error: null };
      }),
    },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) =>
      (m.rpcs.push({ fn, args }), fn === 'list_members')
        ? {
            data: [
              {
                id: 'mem',
                user_id: 'u2',
                email: 'a@b.test',
                display_name: 'Ana',
                role: 'staff',
                location_ids: null,
                has_pin: false,
              },
            ],
            error: null,
          }
        : { data: [], error: null },
    ),
  },
}));
vi.mock('../../../auth/api.ts', () => ({ useSession: () => ({ data: { user: { id: 'me' } } }) }));
vi.mock('../../../auth/current.ts', () => ({
  useCurrentOrg: () => ({ id: 'org', name: 'Org', role: m.role }),
  useCurrentLocation: () => ({
    location: undefined,
    locations: [{ id: 'loc', org_id: 'org', name: 'Main' }],
  }),
}));

beforeAll(() => loadNamespaces('admin-team'));
beforeEach(() => {
  m.role = 'owner';
  m.scoped = false;
  m.updates = [];
  m.rpcs = [];
  m.invites = [];
});
afterEach(cleanup);

function renderTeam() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
        <TeamPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('limit staff to their own lines', () => {
  it('is off by default and an admin can switch it on', async () => {
    m.role = 'admin';
    renderTeam();
    const toggle = await screen.findByRole('switch', { name: /Limit staff to their own lines/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(m.updates).toContainEqual({
        table: 'organizations',
        patch: { scope_staff_to_lines: true },
      }),
    );
  });

  it('hides the setting from staff and managers', async () => {
    m.role = 'manager';
    renderTeam();
    await screen.findByText('Ana');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('offers lines in the edit dialog only while the setting is on, and saves them', async () => {
    renderTeam();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Ana/ }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText('Lines this person works')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    cleanup();

    m.scoped = true;
    renderTeam();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Ana/ }));
    dialog = screen.getByRole('dialog');
    await within(dialog).findByText('Lines this person works');
    fireEvent.click(await within(dialog).findByLabelText(/Chair 1/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(m.rpcs).toContainEqual({
        fn: 'set_member_lines',
        args: expect.objectContaining({ p_membership_id: 'mem', p_queue_ids: ['q1'] }),
      }),
    );
  });

  it('M3b: an admin sets lines too, through the RPC rather than a table write', async () => {
    m.role = 'admin';
    m.scoped = true;
    renderTeam();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Ana/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByLabelText(/Chair 1/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(m.rpcs.map((r) => r.fn)).toContain('set_member_lines'));
    expect(m.updates.filter((u) => u.table === 'memberships')).toEqual([]);
  });
});

describe('M3b: inviting with lines', () => {
  async function openInvite() {
    renderTeam();
    fireEvent.click(await screen.findByRole('button', { name: 'Invite someone' }));
    return screen.getByRole('dialog');
  }

  it('offers no lines while the org setting is off, and sends none', async () => {
    m.role = 'admin';
    const dialog = await openInvite();
    expect(within(dialog).queryByText('Lines this person works')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/Email address/), {
      target: { value: 'new@x.test' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(m.invites).toHaveLength(1));
    expect(m.invites[0]?.queue_ids).toBeNull();
  });

  it('sends the picked lines for a front-desk invite while the setting is on', async () => {
    m.role = 'admin';
    m.scoped = true;
    const dialog = await openInvite();
    await within(dialog).findByText('Lines this person works');
    fireEvent.change(within(dialog).getByLabelText(/Email address/), {
      target: { value: 'new@x.test' },
    });
    fireEvent.click(await within(dialog).findByLabelText(/Chair 1/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(m.invites).toHaveLength(1));
    expect(m.invites[0]).toMatchObject({ role: 'staff', queue_ids: ['q1'] });
  });
});

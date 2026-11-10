import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { AnnouncementsPage } from './AnnouncementsPage.tsx';
import { BlocksPage } from './BlocksPage.tsx';
import { EntitlementOverrides } from './EntitlementOverrides.tsx';
import { HealthPage } from './HealthPage.tsx';
import { SmsPause } from './SmsPause.tsx';
import { StatsPage } from './StatsPage.tsx';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  tables: {} as Record<string, unknown[]>,
}));

// The pages link to tenants; a plain anchor stands in for the router's Link.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => <a href={to.replace('$orgId', params?.orgId ?? '')}>{children}</a>,
}));

// Every table read resolves to that table's rows, however the query is chained.
vi.mock('../../../lib/supabase.ts', () => {
  const read = (table: string) => {
    const result = Promise.resolve({ data: m.tables[table] ?? [], error: null });
    const chain: Record<string, unknown> = {
      then: result.then.bind(result),
    };
    for (const method of ['select', 'order', 'eq']) chain[method] = () => chain;
    return chain;
  };
  return { supabase: { rpc: m.rpc, schema: () => ({ from: read }) } };
});

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => {
  m.rpc.mockReset();
  m.tables = {};
});
afterEach(cleanup);

function show(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const health = {
  notifications_queued: 2,
  notifications_dead: 0,
  oldest_queued_seconds: 30,
  orgs_active_today: 4,
  as_of: '2026-10-25T12:00:00Z',
  cron_jobs: [
    {
      name: 'dispatch',
      schedule: '* * * * *',
      active: true,
      last_start: '2026-10-25T11:59:00Z',
      last_status: 'succeeded',
      last_message: null,
    },
    {
      name: 'platform-stats-tick',
      schedule: '15 0 * * *',
      active: true,
      last_start: null,
      last_status: 'failed',
      last_message: 'function tick() does not exist',
    },
  ],
};

describe('HealthPage', () => {
  it('AC1: shows dead notifications in a warning state', async () => {
    m.rpc.mockResolvedValue({ data: { ...health, notifications_dead: 3 }, error: null });
    show(<HealthPage sentryUrl="https://sentry.example/issues" />);
    const dead = (await screen.findByText('Dead notifications')).closest('[data-health]')!;
    expect(dead.getAttribute('data-health')).toBe('warning');
    expect(within(dead as HTMLElement).getByText('3')).toBeTruthy();
    expect(within(dead as HTMLElement).getByText('Needs attention')).toBeTruthy();
    expect(m.rpc).toHaveBeenCalledWith('platform_health');
    expect(screen.getByRole('link', { name: 'Open error reports' }).getAttribute('href')).toBe(
      'https://sentry.example/issues',
    );
  });

  it('is calm when nothing is dead, and flags the failed cron job only', async () => {
    m.rpc.mockResolvedValue({ data: health, error: null });
    show(<HealthPage sentryUrl="" />);
    const dead = (await screen.findByText('Dead notifications')).closest('[data-health]')!;
    expect(dead.getAttribute('data-health')).toBe('ok');
    expect(screen.queryByText('Needs attention')).toBeNull();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-health'))).toEqual(['ok', 'warning']);
    expect(within(rows[1]!).getByText('Failed')).toBeTruthy();
    expect(within(rows[1]!).getByText('function tick() does not exist')).toBeTruthy();
    expect(within(rows[0]!).queryByText('function tick() does not exist')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('StatsPage', () => {
  it('asks for the last 30 UTC days and totals each business', async () => {
    const row = (org_id: string, day: string, joins: number) => ({
      org_id,
      day,
      joins,
      served: joins,
      no_shows: 0,
      cancelled: 0,
      notifications_sent: 0,
      notifications_failed: 0,
      computed_at: day,
    });
    m.rpc.mockImplementation((name: string) =>
      Promise.resolve({
        data:
          name === 'platform_list_orgs'
            ? [
                { id: 'org-a', name: 'Demo Barber' },
                { id: 'org-b', name: 'Other Salon' },
              ]
            : [
                row('org-a', '2026-10-24', 2),
                row('org-b', '2026-10-24', 5),
                row('org-a', '2026-10-23', 1),
              ],
        error: null,
      }),
    );
    show(<StatsPage now={Date.parse('2026-10-25T08:00:00Z')} />);
    expect(await screen.findByRole('img', { name: 'Joins per day, last 30 days' })).toBeTruthy();
    expect(m.rpc).toHaveBeenCalledWith('platform_stats', {
      p_from: '2026-09-26',
      p_to: '2026-10-25',
    });
    const perOrg = screen.getByRole('region', { name: 'Per business' });
    // #582: names, not ids, and each links to the tenant's page.
    await within(perOrg).findByRole('link', { name: 'Other Salon' });
    const rows = within(perOrg).getAllByRole('row').slice(1);
    expect(
      rows.map((r) => [r.querySelector('th')!.textContent, r.querySelector('td')!.textContent]),
    ).toEqual([
      ['Other Salon', '5'],
      ['Demo Barber', '3'],
    ]);
    expect(within(perOrg).getByRole('link', { name: 'Demo Barber' }).getAttribute('href')).toBe(
      '/platform/orgs/org-a',
    );
  });

  it('names a business the directory page does not cover by its id', async () => {
    m.rpc.mockImplementation((name: string) =>
      Promise.resolve({
        data:
          name === 'platform_list_orgs'
            ? []
            : [
                {
                  org_id: 'org-z',
                  day: '2026-10-24',
                  joins: 1,
                  served: 1,
                  no_shows: 0,
                  cancelled: 0,
                  notifications_sent: 0,
                  notifications_failed: 0,
                  computed_at: '2026-10-24',
                },
              ],
        error: null,
      }),
    );
    show(<StatsPage now={Date.parse('2026-10-25T08:00:00Z')} />);
    expect(await screen.findByRole('link', { name: 'org-z' })).toBeTruthy();
  });
});

describe('EntitlementOverrides', () => {
  beforeEach(() => {
    m.tables = {
      entitlement_defaults: [
        { key: 'kiosk.enabled', value: false, description: 'Kiosk mode' },
        { key: 'queues.max', value: 3, description: 'Queues per location' },
      ],
      org_entitlements: [
        { key: 'queues.max', value: 10, reason: 'pilot', set_at: '2026-10-25T00:00:00Z' },
      ],
    };
    m.rpc.mockResolvedValue({ data: null, error: null });
  });

  it('lists defaults and this business’s override', async () => {
    show(<EntitlementOverrides orgId="org-1" />);
    const row = (await screen.findByRole('rowheader', { name: 'queues.max' })).closest('tr')!;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['3', '10', 'pilot']);
  });

  it('rejects a value that is not JSON, then saves a parsed one with the reason', async () => {
    const user = userEvent.setup();
    show(<EntitlementOverrides orgId="org-1" />);
    await user.selectOptions(await screen.findByLabelText('Entitlement'), 'kiosk.enabled');
    await user.type(screen.getByLabelText('Value (JSON)'), 'yes');
    await user.type(screen.getByLabelText('Reason'), 'trial');
    await user.click(screen.getByRole('button', { name: 'Save override' }));
    expect(screen.getByText('Enter a JSON value, such as true or 10.')).toBeTruthy();
    expect(m.rpc).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Value (JSON)'));
    await user.type(screen.getByLabelText('Value (JSON)'), 'true');
    await user.click(screen.getByRole('button', { name: 'Save override' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_set_entitlement', {
        p_org_id: 'org-1',
        p_key: 'kiosk.enabled',
        p_value: true,
        p_reason: 'trial',
      }),
    );
  });

  it('#583: a blank reason says so, not that the value is bad JSON', async () => {
    const user = userEvent.setup();
    show(<EntitlementOverrides orgId="org-1" />);
    await user.selectOptions(await screen.findByLabelText('Entitlement'), 'kiosk.enabled');
    await user.type(screen.getByLabelText('Value (JSON)'), 'true');
    await user.type(screen.getByLabelText('Reason'), '   ');
    await user.click(screen.getByRole('button', { name: 'Save override' }));
    expect(screen.getByText('Give a reason. It is kept in the audit log.')).toBeTruthy();
    expect(screen.queryByText('Enter a JSON value, such as true or 10.')).toBeNull();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('clears an override only after a confirm, sending null', async () => {
    const user = userEvent.setup();
    show(<EntitlementOverrides orgId="org-1" />);
    await user.selectOptions(await screen.findByLabelText('Entitlement'), 'queues.max');
    const clear = screen.getByRole('button', { name: 'Clear override' });
    expect(clear.hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByLabelText('Reason'), 'pilot over');
    await user.click(clear);
    expect(m.rpc).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear override' }),
    );
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_set_entitlement', {
        p_org_id: 'org-1',
        p_key: 'queues.max',
        p_value: null,
        p_reason: 'pilot over',
      }),
    );
  });
});

describe('AnnouncementsPage', () => {
  // Whole minutes, as a datetime-local field round-trips them.
  const at = (hours: number) =>
    new Date(Math.floor(Date.now() / 60_000) * 60_000 + hours * 3_600_000).toISOString();
  const live = {
    id: 'a1',
    severity: 'maintenance',
    message: 'Down Sunday 2am',
    starts_at: at(-1),
    ends_at: at(24),
  };
  const scheduled = {
    id: 'a2',
    severity: 'info',
    message: 'New reports page',
    starts_at: at(24),
    ends_at: at(48),
  };
  beforeEach(() => {
    m.rpc.mockImplementation(async (fn: string) =>
      fn === 'platform_list_announcements'
        ? { data: [live, scheduled], error: null }
        : { data: 'new-id', error: null },
    );
  });
  const upserts = () => m.rpc.mock.calls.filter(([fn]) => fn === 'platform_upsert_announcement');

  it('publishes a new announcement with its end as an instant', async () => {
    const user = userEvent.setup();
    show(<AnnouncementsPage />);
    await user.selectOptions(await screen.findByLabelText('Type'), 'warning');
    await user.type(screen.getByLabelText('Message'), 'Texts are slow');
    await user.type(screen.getByLabelText('Ends'), '2026-10-30T18:00');
    await user.click(screen.getByRole('button', { name: 'Publish announcement' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_upsert_announcement', {
        p_severity: 'warning',
        p_message: 'Texts are slow',
        p_ends_at: new Date('2026-10-30T18:00').toISOString(),
        p_starts_at: undefined,
        p_id: undefined,
      }),
    );
  });

  it('edits a live announcement in place', async () => {
    const user = userEvent.setup();
    show(<AnnouncementsPage />);
    await user.click(
      await screen.findByRole('button', { name: 'Edit announcement: Down Sunday 2am' }),
    );
    const message = screen.getByLabelText('Message');
    await user.clear(message);
    await user.type(message, 'Down Sunday 3am');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_upsert_announcement', {
        p_severity: 'maintenance',
        p_message: 'Down Sunday 3am',
        p_ends_at: live.ends_at,
        p_starts_at: live.starts_at,
        p_id: 'a1',
      }),
    );
  });

  it('lists scheduled announcements with their start', async () => {
    show(<AnnouncementsPage />);
    expect(await screen.findByText('New reports page')).toBeTruthy();
    expect(screen.getByText(/^Scheduled: /)).toBeTruthy();
    expect(screen.getByText(/^Showing until /)).toBeTruthy();
    expect(m.rpc).toHaveBeenCalledWith('platform_list_announcements');
  });

  it('ends a live one now after a confirm, keeping its start', async () => {
    const user = userEvent.setup();
    show(<AnnouncementsPage />);
    await user.click(
      await screen.findByRole('button', { name: 'End announcement now: Down Sunday 2am' }),
    );
    expect(upserts()).toEqual([]);
    const before = Date.now();
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'End announcement' }),
    );
    await waitFor(() => expect(upserts()).toHaveLength(1));
    const [, args] = upserts()[0]!;
    expect(args).toMatchObject({
      p_id: 'a1',
      p_starts_at: live.starts_at,
      p_severity: 'maintenance',
    });
    expect(Date.parse(args.p_ends_at)).toBeGreaterThanOrEqual(before);
  });

  it('cancels a scheduled one by ending it now, with a start just before', async () => {
    const user = userEvent.setup();
    show(<AnnouncementsPage />);
    await user.click(
      await screen.findByRole('button', { name: 'End announcement now: New reports page' }),
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'End announcement' }),
    );
    await waitFor(() => expect(upserts()).toHaveLength(1));
    const [, args] = upserts()[0]!;
    expect(args.p_id).toBe('a2');
    expect(Date.parse(args.p_starts_at)).toBeLessThan(Date.parse(args.p_ends_at));
    expect(Date.parse(args.p_ends_at)).toBeLessThanOrEqual(Date.now());
  });
});

describe('BlocksPage', () => {
  const block = {
    kind: 'phone',
    reason: 'Prank joins',
    created_at: '2026-10-25T10:00:00Z',
    expires_at: null,
  };
  beforeEach(() => {
    m.tables = {
      platform_blocks: [
        block,
        { ...block, kind: 'email', reason: 'Old', expires_at: '2020-01-01T00:00:00Z' },
      ],
    };
    m.rpc.mockResolvedValue({ data: null, error: null });
  });

  it('AC2: lists kind, reason and expiry, and no contact', async () => {
    show(<BlocksPage />);
    const rows = await screen.findAllByTestId('block');
    expect(
      rows.map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['Phone', 'Prank joins', expect.any(String), 'Until removed'],
      ['Email', 'Old', expect.any(String), 'Expired'],
    ]);
    expect(screen.getByRole('table').textContent).not.toMatch(/\+\d{6,}|@/);
  });

  it('blocks a contact until removed, then clears the contact from the form', async () => {
    const user = userEvent.setup();
    show(<BlocksPage />);
    await user.type(await screen.findByLabelText('Phone or email'), '+14155550123');
    await user.type(screen.getByLabelText('Reason'), 'Prank joins');
    await user.click(screen.getByRole('button', { name: 'Block contact' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_block_contact', {
        p_value: '+14155550123',
        p_kind: 'phone',
        p_reason: 'Prank joins',
        p_expires_at: null,
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Phone or email') as HTMLInputElement).value).toBe(''),
    );
  });

  it('says so when the reason carries the contact', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { message: 'invalid_input', details: 'reason_contains_contact' },
    });
    const user = userEvent.setup();
    show(<BlocksPage />);
    await user.type(await screen.findByLabelText('Phone or email'), '+14155550123');
    await user.type(screen.getByLabelText('Reason'), 'it was 5550123');
    await user.click(screen.getByRole('button', { name: 'Block contact' }));
    expect(await screen.findByText(/The reason contains the contact/)).toBeTruthy();
  });

  it('removes a block only after a confirm', async () => {
    const user = userEvent.setup();
    show(<BlocksPage />);
    await user.type(await screen.findByLabelText('Phone or email to unblock'), '+14155550123');
    await user.click(screen.getByRole('button', { name: 'Remove block' }));
    expect(m.rpc).not.toHaveBeenCalledWith('platform_unblock_contact', expect.anything());
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove block' }),
    );
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_unblock_contact', {
        p_value: '+14155550123',
        p_kind: 'phone',
      }),
    );
  });
});

describe('SmsPause', () => {
  const stats = { sent: 100, filtered: 6, undelivered: 1, stops: 0 };

  it('shows an automatic pause with its reason and the counts', async () => {
    m.rpc.mockResolvedValue({
      data: { platform_mode: true, state: 'auto', reason: 'filtered_rate', stats_24h: stats },
      error: null,
    });
    show(<SmsPause orgId="org-1" canAct />);
    expect((await screen.findByTestId('sms-pause-status')).textContent).toBe(
      'Paused automatically: too many messages filtered by carriers.',
    );
    expect(screen.getByText(/100 sent, 0 STOP replies, 6 filtered/)).toBeTruthy();
  });

  it('lets an operator resume with a reason; support only reads', async () => {
    const user = userEvent.setup();
    m.rpc.mockImplementation((name: string) =>
      Promise.resolve({
        data:
          name === 'platform_sms_health'
            ? { platform_mode: true, state: 'auto', reason: 'stop_rate', stats_24h: stats }
            : null,
        error: null,
      }),
    );
    show(<SmsPause orgId="org-1" canAct />);
    await user.type(await screen.findByLabelText('Reason'), 'carrier confirmed one-off');
    await user.click(screen.getByRole('button', { name: 'Resume text messages' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_set_sms_pause', {
        p_org_id: 'org-1',
        p_pause: false,
        p_reason: 'carrier confirmed one-off',
      }),
    );
    cleanup();
    show(<SmsPause orgId="org-1" canAct={false} />);
    await screen.findByTestId('sms-pause-status');
    expect(screen.queryByRole('button', { name: /text messages/ })).toBeNull();
  });

  it('says so for a business not on the platform number', async () => {
    m.rpc.mockResolvedValue({ data: { platform_mode: false, stats_24h: stats }, error: null });
    show(<SmsPause orgId="org-1" canAct />);
    expect(
      await screen.findByText(/doesn't send text messages through the QueueThat number/),
    ).toBeTruthy();
  });
});

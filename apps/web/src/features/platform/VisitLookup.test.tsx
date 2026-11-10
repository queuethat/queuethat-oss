import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { VisitLookup } from './VisitLookup.tsx';
import { formatInZone } from './format.ts';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));

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
vi.mock('../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => m.rpc.mockReset());
afterEach(cleanup);

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VisitLookup orgId="org-a" />
    </QueryClientProvider>,
  );
}

const hit = {
  visit_id: 'v1',
  display_ticket: 'A042',
  queue_id: 'q1',
  queue_name: 'Walk-ins',
  location_id: 'l1',
  location_name: 'Main street',
  service_day: '2026-03-01',
  status: 'waiting',
  joined_at: '2026-03-02T03:30:00Z',
  finished_at: null,
};
const timeline = {
  visit_id: 'v1',
  display_ticket: 'A042',
  status: 'waiting',
  queue_name: 'Walk-ins',
  location_name: 'Main street',
  tz: 'America/New_York',
  service_day: '2026-03-01',
  source: 'online',
  party_size: 2,
  call_count: 1,
  joined_at: '2026-03-02T03:30:00Z',
  finished_at: null,
  support_grant: {
    id: 'g1',
    scope: 'read',
    reason: 'Guest says never called',
    break_glass: false,
    created_at: '2026-03-02T03:00:00Z',
    expires_at: '2026-03-03T03:00:00Z',
  },
  events: [
    {
      id: 1,
      type: 'joined',
      from_status: null,
      to_status: 'waiting',
      actor_kind: 'system',
      occurred_at: '2026-03-02T03:30:00Z',
      undone: false,
      via_support: false,
      undoes_type: null,
    },
    {
      id: 2,
      type: 'call',
      from_status: 'waiting',
      to_status: 'called',
      actor_kind: 'platform',
      occurred_at: '2026-03-02T03:40:00Z',
      undone: true,
      via_support: true,
      undoes_type: null,
    },
    {
      id: 3,
      type: 'undo',
      from_status: 'called',
      to_status: 'waiting',
      actor_kind: 'staff',
      occurred_at: '2026-03-02T03:41:00Z',
      undone: false,
      via_support: false,
      undoes_type: 'call',
    },
  ],
  notifications: [
    {
      id: 'n1',
      event_id: 2,
      channel: 'sms',
      template_key: 'called',
      category: 'transactional',
      status: 'failed',
      attempts: 3,
      error_code: 'undeliverable',
      created_at: '2026-03-02T03:40:05Z',
      updated_at: '2026-03-02T03:41:05Z',
      recipient: '+•••••••0188',
    },
  ],
};

function rpcs(overrides: Record<string, unknown> = {}) {
  m.rpc.mockImplementation((name: string) => {
    const result =
      name in overrides ? overrides[name] : name === 'platform_search_visits' ? [hit] : timeline;
    return Promise.resolve(
      result instanceof Error
        ? { data: null, error: { message: result.message } }
        : { data: result, error: null },
    );
  });
}

const search = async () => userEvent.click(screen.getByRole('button', { name: 'Search' }));

describe('VisitLookup', () => {
  it('does not look anything up until the form is submitted (every lookup is audited)', async () => {
    rpcs();
    show();
    await screen.findByRole('heading', { name: 'Visit lookup' });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('sends only the filters that were filled in', async () => {
    rpcs();
    show();
    await userEvent.type(screen.getByLabelText('Ticket number'), ' A042 ');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'waiting');
    await search();
    await screen.findByTestId('hit');
    expect(m.rpc.mock.calls.filter(([n]) => n === 'platform_search_visits')).toHaveLength(1);
    expect(m.rpc).toHaveBeenCalledWith('platform_search_visits', {
      p_org_id: 'org-a',
      p_ticket: 'A042',
      p_status: 'waiting',
    });
  });

  it('shows the grant banner, local times and masked recipients on the timeline', async () => {
    rpcs();
    show();
    await search();
    await userEvent.click(await screen.findByRole('button', { name: /Open timeline/ }));
    const banner = await screen.findByTestId('grant-banner');
    expect(within(banner).getByText(/Guest says never called/)).toBeTruthy();
    expect(within(banner).getByText(/read-only/)).toBeTruthy();
    expect(m.rpc).toHaveBeenCalledWith('platform_visit_timeline', {
      p_org_id: 'org-a',
      p_visit_id: 'v1',
    });

    const events = screen.getAllByTestId('event');
    expect(events).toHaveLength(3);
    expect(events[1]!.textContent).toContain('via support access');
    expect(events[1]!.textContent).toContain('undone');
    expect(events[1]!.textContent).toContain('Support');
    expect(events[2]!.textContent).toContain('reverses call');
    // 03:30 UTC is 10:30 pm the evening before in New York: the page shows the location's time.
    expect(events[0]!.textContent).toContain(
      formatInZone('2026-03-02T03:30:00Z', 'en', 'America/New_York'),
    );
    expect(events[0]!.textContent).toContain('Mar 1, 2026');

    const row = screen.getByTestId('notification');
    expect(row.textContent).toContain('+•••••••0188');
    expect(row.textContent).toContain('undeliverable');
    expect(row.textContent).toContain('3 attempts');
  });

  it('shows break-glass access in the banner', async () => {
    rpcs({
      platform_visit_timeline: {
        ...timeline,
        support_grant: { ...timeline.support_grant, break_glass: true },
      },
    });
    show();
    await search();
    await userEvent.click(await screen.findByRole('button', { name: /Open timeline/ }));
    expect((await screen.findByTestId('grant-banner')).textContent).toContain('Break-glass');
  });

  it('with no grant, explains how to request one and shows no visit data', async () => {
    rpcs({ platform_search_visits: new Error('permission_denied') });
    show();
    await search();
    expect(await screen.findByText('No support access to this business')).toBeTruthy();
    expect(screen.getByText(/Ask the owner to grant read access/)).toBeTruthy();
    expect(screen.queryByTestId('hit')).toBeNull();
    expect(screen.queryByTestId('timeline')).toBeNull();
    // The pointer back to the business page, where an operator can open break-glass.
    const link = await screen.findByRole('link', { name: /break-glass/i });
    expect(link.getAttribute('href')).toBe('/platform/orgs/org-a');
  });

  it('handles a grant that ends between search and opening the timeline', async () => {
    rpcs({ platform_visit_timeline: new Error('permission_denied') });
    show();
    await search();
    await userEvent.click(await screen.findByRole('button', { name: /Open timeline/ }));
    expect(await screen.findByText('No support access to this business')).toBeTruthy();
    expect(screen.queryByTestId('timeline')).toBeNull();
  });

  it('says so for a visit that is gone, and for no matches', async () => {
    rpcs({ platform_visit_timeline: new Error('not_found') });
    show();
    await search();
    await userEvent.click(await screen.findByRole('button', { name: /Open timeline/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('no longer exists');
    cleanup();

    rpcs({ platform_search_visits: [] });
    show();
    await search();
    expect(await screen.findByText('No visits match.')).toBeTruthy();
  });

  it('reports any other failure without exposing the code', async () => {
    rpcs({ platform_search_visits: new Error('boom') });
    show();
    await search();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Check your connection'),
    );
  });

  it('says there were no messages or events when there are none', async () => {
    rpcs({ platform_visit_timeline: { ...timeline, events: [], notifications: [] } });
    show();
    await search();
    await userEvent.click(await screen.findByRole('button', { name: /Open timeline/ }));
    expect(await screen.findByText('No events recorded.')).toBeTruthy();
    expect(screen.getByText('No messages were sent for this visit.')).toBeTruthy();
  });
});

describe('repeat searches', () => {
  it('each submit is exactly one audited call, even with the same filters', async () => {
    rpcs();
    show();
    await search();
    await screen.findByTestId('hit');
    await search();
    await waitFor(() =>
      expect(m.rpc.mock.calls.filter(([n]) => n === 'platform_search_visits')).toHaveLength(2),
    );
  });
});

describe('formatInZone', () => {
  it('renders an instant in the location zone, not the viewer zone', () => {
    const utc = '2026-03-02T03:30:00Z';
    expect(formatInZone(utc, 'en', 'America/New_York')).toContain('Mar 1, 2026');
    expect(formatInZone(utc, 'en', 'Europe/Berlin')).toContain('Mar 2, 2026');
    expect(formatInZone(utc, 'en', 'Pacific/Auckland')).toContain('Mar 2, 2026');
  });
});

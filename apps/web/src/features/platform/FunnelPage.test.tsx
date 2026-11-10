import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { ActivationBadge, ActivationSection, activationBadge } from './Activation.tsx';
import { STUCK_PAGE, type Activation, type Funnel } from './api.ts';
import { FUNNEL_STAGES } from './funnel.ts';
import { FunnelPage } from './FunnelPage.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn(), navigate: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => m.navigate,
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, unknown>;
    children: ReactNode;
  }) => (
    <a href={to.replace('$orgId', params?.orgId ?? '')} data-search={JSON.stringify(search ?? {})}>
      {children}
    </a>
  ),
}));
vi.mock('../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => {
  m.rpc.mockReset();
  m.navigate.mockReset();
});
afterEach(cleanup);

function show(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const COUNTS = [10, 9, 6, 5, 4, 3, 1, 1, 2];
const funnel = (over: Partial<Funnel> = {}): Funnel => ({
  from_date: '2026-10-01',
  to_date: '2026-10-30',
  stages: FUNNEL_STAGES.map((stage, i) => ({
    stage,
    count: COUNTS[i]!,
    conversion_prev: i === 0 ? null : 0.5,
    conversion_start: 0.1,
  })),
  signups_without_business: 1,
  stuck_total: 2,
  stuck: [
    {
      org_id: 'org-1',
      name: 'Slow Salon',
      owner_email: 'a@salon.test',
      stage: 'location_added',
      reached_at: '2026-10-10T10:00:00Z',
      stuck_days: 12,
    },
    {
      org_id: 'org-2',
      name: 'Idle Barber',
      owner_email: null,
      stage: 'first_guest',
      reached_at: '2026-10-20T10:00:00Z',
      stuck_days: 1,
    },
  ],
  ...over,
});
const resolve = (data: Funnel) => m.rpc.mockResolvedValue({ data, error: null });

describe('FunnelPage', () => {
  it('shows every stage with its count and conversion, and the stuck tenants with a link', async () => {
    resolve(funnel());
    show(<FunnelPage filter={{}} />);
    const stages = await screen.findAllByTestId('stage');
    expect(stages.map((s) => s.getAttribute('data-stage'))).toEqual([...FUNNEL_STAGES]);
    expect(within(stages[0]!).getByText('Signed up')).toBeTruthy();
    expect(within(stages[0]!).getByText('10')).toBeTruthy();
    expect(within(stages[1]!).getByText(/50% of the previous stage/)).toBeTruthy();
    expect(within(stages[8]!).getByText(/50% of signups/)).toBeTruthy();
    expect(
      screen.getByText('1 account signed up in this range and never created a business.'),
    ).toBeTruthy();
    expect(screen.getByText('2 businesses stuck before their first served guest')).toBeTruthy();

    const rows = screen.getAllByTestId('stuck');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('link', { name: 'Slow Salon' }).getAttribute('href')).toBe(
      '/platform/orgs/org-1',
    );
    expect(within(rows[0]!).getByText('12')).toBeTruthy();
    expect(within(rows[0]!).getByText('Location added')).toBeTruthy();
  });

  it('sends the range, stage and page to the database as given, and nothing else', async () => {
    resolve(funnel());
    show(
      <FunnelPage filter={{ from: '2026-10-01', to: '2026-10-30', stage: 'line_live', page: 2 }} />,
    );
    await screen.findAllByTestId('stage');
    expect(m.rpc).toHaveBeenCalledWith('platform_funnel', {
      p_limit: STUCK_PAGE,
      p_offset: 2 * STUCK_PAGE,
      p_from: '2026-10-01',
      p_to: '2026-10-30',
      p_stage: 'line_live',
    });
  });

  it('asks for the default range when none is chosen', async () => {
    resolve(funnel());
    show(<FunnelPage filter={{}} />);
    await screen.findAllByTestId('stage');
    expect(m.rpc).toHaveBeenCalledWith('platform_funnel', { p_limit: STUCK_PAGE, p_offset: 0 });
  });

  it('copes with an empty range: zero counts, no division by nothing, no stuck rows', async () => {
    resolve(
      funnel({
        stages: FUNNEL_STAGES.map((stage) => ({
          stage,
          count: 0,
          conversion_prev: null,
          conversion_start: null,
        })),
        signups_without_business: 0,
        stuck_total: 0,
        stuck: [],
      }),
    );
    show(<FunnelPage filter={{}} />);
    expect(await screen.findByText('No business is stuck.')).toBeTruthy();
    expect(screen.queryByTestId('stuck')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
    expect(screen.getAllByText(/– of the previous stage/).length).toBeGreaterThan(0);
  });

  it('pages the stuck list: first, middle and last page show the right links', async () => {
    const total = STUCK_PAGE * 2 + 1;
    resolve(funnel({ stuck_total: total }));
    const { unmount } = show(<FunnelPage filter={{}} />);
    await screen.findAllByTestId('stage');
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Previous page' })).toBeNull();
    expect(
      JSON.parse(screen.getByRole('link', { name: 'Next page' }).getAttribute('data-search')!),
    ).toEqual({
      page: 1,
    });
    unmount();

    show(<FunnelPage filter={{ page: 1 }} />);
    await screen.findByText('Page 2 of 3');
    expect(
      JSON.parse(screen.getByRole('link', { name: 'Previous page' }).getAttribute('data-search')!),
    ).toEqual({});
    cleanup();

    show(<FunnelPage filter={{ page: 2 }} />);
    await screen.findByText('Page 3 of 3');
    expect(screen.queryByRole('link', { name: 'Next page' })).toBeNull();
  });

  it('exactly one full page has no pager', async () => {
    resolve(funnel({ stuck_total: STUCK_PAGE }));
    show(<FunnelPage filter={{}} />);
    await screen.findAllByTestId('stage');
    expect(screen.queryByText(/Page 1 of/)).toBeNull();
  });

  it('says so when the address points past the end', async () => {
    resolve(funnel({ stuck_total: 3, stuck: [] }));
    show(<FunnelPage filter={{ page: 9 }} />);
    expect(await screen.findByText('No more businesses on this page.')).toBeTruthy();
  });

  it('filters by stage from the select and goes back to the first page', async () => {
    resolve(funnel());
    show(<FunnelPage filter={{ page: 3, from: '2026-10-01' }} />);
    await screen.findAllByTestId('stage');
    await userEvent.selectOptions(screen.getByLabelText('Stopped at'), 'line_live');
    expect(m.navigate).toHaveBeenCalledWith({
      to: '/platform/funnel',
      search: { from: '2026-10-01', page: undefined, stage: 'line_live' },
    });
  });

  it('applies a new range and clears the page', async () => {
    resolve(funnel());
    show(<FunnelPage filter={{ page: 3 }} />);
    await screen.findAllByTestId('stage');
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(m.navigate).toHaveBeenCalledWith({
      to: '/platform/funnel',
      search: { page: undefined, from: '2026-10-01', to: '2026-10-30' },
    });
  });

  it('shows an error, not an empty funnel, when the call fails', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission_denied' } });
    show(<FunnelPage filter={{}} />);
    await waitFor(() =>
      expect(
        screen.getByText("Couldn't load this. Check your connection, then reload."),
      ).toBeTruthy(),
    );
    expect(screen.queryByTestId('stage')).toBeNull();
  });
});

const activation = (over: Partial<Activation> = {}): Activation => ({
  org_id: 'org-1',
  org_status: 'active',
  stage: 'location_added',
  next_stage: 'queue_created',
  reached_at: '2026-10-10T10:00:00Z',
  stuck_days: 12,
  is_stuck: true,
  stages: FUNNEL_STAGES.map((stage, i) => ({
    stage,
    reached_at: i < 3 ? '2026-10-10T10:00:00Z' : null,
  })),
  ...over,
});

describe('activation badge', () => {
  it('maps the database verdict to a badge: done, suspended, stuck, on track', () => {
    expect(
      activationBadge(activation({ stage: 'first_served', is_stuck: false, stuck_days: null })).key,
    ).toBe('done');
    expect(activationBadge(activation({ org_status: 'suspended', is_stuck: false })).key).toBe(
      'suspended',
    );
    expect(activationBadge(activation()).key).toBe('stuck');
    expect(activationBadge(activation({ is_stuck: false, stuck_days: 1 })).key).toBe('onTrack');
    // A served tenant is done even if it is suspended now.
    expect(
      activationBadge(
        activation({ stage: 'first_served', org_status: 'suspended', is_stuck: false }),
      ).key,
    ).toBe('done');
  });

  it('renders the stage and days for a stuck tenant, a dash while unknown', () => {
    const { unmount } = render(<ActivationBadge activation={activation()} />);
    expect(screen.getByText('Stuck')).toBeTruthy();
    expect(screen.getByText('Location added · Stuck here for 12 days.')).toBeTruthy();
    unmount();
    render(<ActivationBadge activation={undefined} />);
    expect(screen.getByText('–')).toBeTruthy();
  });

  it('says "1 day", not "1 days"', () => {
    render(<ActivationBadge activation={activation({ stuck_days: 1 })} />);
    expect(screen.getByText(/Stuck here for 1 day\./)).toBeTruthy();
  });
});

describe('ActivationSection', () => {
  it('lists all nine stages, reached ones dated and the rest marked not reached', () => {
    render(<ActivationSection activation={activation()} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(9);
    expect(items.filter((i) => i.getAttribute('data-reached') === 'yes')).toHaveLength(3);
    expect(within(items[8]!).getByText('Not reached')).toBeTruthy();
    expect(screen.getByText('Stuck here for 12 days.')).toBeTruthy();
  });

  it('does not call a suspended or finished tenant stuck', () => {
    const { unmount } = render(
      <ActivationSection activation={activation({ org_status: 'suspended', is_stuck: false })} />,
    );
    expect(screen.getByText('Suspended, so not counted as stuck.')).toBeTruthy();
    unmount();
    render(
      <ActivationSection
        activation={activation({ stage: 'first_served', stuck_days: null, is_stuck: false })}
      />,
    );
    expect(screen.getByText('Has served its first guest.')).toBeTruthy();
  });
});

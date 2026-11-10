import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { formatWhen } from '../format.ts';
import type { BillingOverview as Overview, OrgBilling } from './api.ts';
import { BillingOverview } from './BillingOverview.tsx';
import { BillingPanel } from './BillingPanel.tsx';

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
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => m.rpc.mockReset());
afterEach(cleanup);

function show(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const base: OrgBilling = {
  billing_enabled: true,
  org_status: 'active',
  has_subscription: true,
  plan_id: 'standard',
  plan_name: 'Standard',
  effective_plan: 'standard',
  billing_interval: 'month',
  status: 'active',
  standing: 'good',
  current_period_end: '2026-12-31T23:30:00Z',
  locations_billed: 2,
  locations_wanted: 2,
  locations_actual: 2,
  grace_ends_at: null,
  last_payment_failed_at: null,
  grace_reminder_at: null,
  stripe_customer_id: 'cus_Abc123',
  entitlements: [
    { key: 'limit.locations', value: -1, source: 'plan' },
    { key: 'limit.members', value: -1, source: 'plan' },
    { key: 'paid_channels', value: true, source: 'default' },
  ],
  overrides: [],
  pending_jobs: [],
};

function serve(billing: Partial<OrgBilling>) {
  m.rpc.mockResolvedValue({ data: { ...base, ...billing }, error: null });
}
const panel = (props: { dashboardUrl?: string } = {}) =>
  show(<BillingPanel orgId="org-1" dashboardUrl={props.dashboardUrl ?? ''} />);

describe('BillingPanel', () => {
  it('asks the database for the org and explains a healthy subscription', async () => {
    serve({});
    panel();
    expect(await screen.findByText('In good standing')).toBeTruthy();
    expect(m.rpc).toHaveBeenCalledWith('platform_org_billing', { p_org_id: 'org-1' });
    expect(screen.getByTestId('billing-why').textContent).toContain(
      'Standard subscription is in good standing',
    );
    expect(screen.getByText('Standard · Monthly')).toBeTruthy();
    expect(screen.getByText('2 billed, 2 wanted, 2 exist')).toBeTruthy();
    expect(screen.queryByTestId('billing-quantity-mismatch')).toBeNull();
  });

  it('shows annual billing and renders the period end as the same instant the database sent', async () => {
    serve({ billing_interval: 'year' });
    panel();
    expect(await screen.findByText('Standard · Annual')).toBeTruthy();
    // 23:30 UTC on Dec 31 is already Jan 1 in some zones: the page formats the instant, nothing else
    expect(screen.getByText(formatWhen('2026-12-31T23:30:00Z', 'en', ''))).toBeTruthy();
  });

  it('no subscription: says the business is on the free plan and has no Stripe link', async () => {
    serve({
      has_subscription: false,
      plan_id: null,
      plan_name: null,
      effective_plan: 'free',
      billing_interval: null,
      status: null,
      standing: 'no_subscription',
      current_period_end: null,
      locations_billed: null,
      locations_wanted: null,
      stripe_customer_id: null,
      locations_actual: 1,
      entitlements: [{ key: 'limit.locations', value: 1, source: 'plan' }],
    });
    panel();
    expect(await screen.findByText('No subscription', { selector: 'span, div' })).toBeTruthy();
    expect(screen.getByTestId('billing-why').textContent).toContain('never subscribed');
    expect(screen.getByText('1 exist')).toBeTruthy();
    expect(screen.getByText('No Stripe customer yet')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open in Stripe' })).toBeNull();
    expect(
      screen.getByText('No syncs waiting. Stripe has the location count we want.'),
    ).toBeTruthy();
  });

  it('past_due inside the grace period: names the date the free plan starts', async () => {
    serve({
      status: 'past_due',
      standing: 'grace',
      grace_ends_at: '2026-11-15T10:00:00Z',
      last_payment_failed_at: '2026-11-01T10:00:00Z',
      grace_reminder_at: null,
    });
    panel();
    expect(await screen.findByText('Payment failing')).toBeTruthy();
    expect(screen.getByText('Past due')).toBeTruthy();
    const why = screen.getByTestId('billing-why').textContent ?? '';
    expect(why).toContain('keeps the Standard plan');
    expect(why).toContain(formatWhen('2026-11-15T10:00:00Z', 'en', ''));
    expect(screen.getByText(formatWhen('2026-11-01T10:00:00Z', 'en', ''))).toBeTruthy();
  });

  it('past_due after the grace period: on the free plan with its limits, Stripe still past due', async () => {
    serve({
      status: 'past_due',
      standing: 'free',
      effective_plan: 'free',
      grace_ends_at: '2026-11-01T00:00:00Z',
      grace_reminder_at: '2026-10-29T00:00:00Z',
      entitlements: [{ key: 'limit.locations', value: 1, source: 'plan' }],
    });
    panel();
    expect(await screen.findByText('On the free plan')).toBeTruthy();
    expect(screen.getByTestId('billing-why').textContent).toContain('free plan');
    const row = screen.getByRole('row', { name: /limit\.locations/ });
    expect(within(row).getByText('1')).toBeTruthy();
    expect(within(row).getByText('The plan')).toBeTruthy();
  });

  it('canceled: keeps the plan on record but shows the free plan in effect', async () => {
    serve({ status: 'canceled', standing: 'free', effective_plan: 'free' });
    panel();
    expect(await screen.findByText('Canceled')).toBeTruthy();
    expect(screen.getByText('On the free plan')).toBeTruthy();
    expect(screen.getByText('Standard · Monthly')).toBeTruthy();
    expect(screen.getByText('free')).toBeTruthy();
  });

  it('an unknown Stripe status is shown as sent, not hidden', async () => {
    serve({ status: 'something_new' });
    panel();
    expect(await screen.findByText('something_new')).toBeTruthy();
  });

  it('billing off: says nothing is limited', async () => {
    serve({ billing_enabled: false, standing: 'billing_off', effective_plan: null });
    panel();
    expect(await screen.findByText('Billing off')).toBeTruthy();
    expect(screen.getByText('None: billing is off, so nothing is limited')).toBeTruthy();
    expect(screen.getByTestId('billing-why').textContent).toContain('free and unlimited');
  });

  it('overrides: shows value, reason, who set it and when, and marks the limit as overridden', async () => {
    serve({
      entitlements: [{ key: 'limit.locations', value: 10, source: 'override' }],
      overrides: [
        {
          key: 'limit.locations',
          value: 10,
          reason: 'Pilot customer',
          set_by_email: 'ops@queuethat.test',
          set_at: '2026-10-01T12:00:00Z',
        },
        {
          key: 'limit.members',
          value: 8,
          reason: 'Old pilot',
          set_by_email: null,
          set_at: '2026-09-01T12:00:00Z',
        },
      ],
    });
    panel();
    const rows = await screen.findAllByRole('row', { name: /Pilot customer|Old pilot/ });
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('ops@queuethat.test')).toBeTruthy();
    expect(within(rows[0]!).getByText(formatWhen('2026-10-01T12:00:00Z', 'en', ''))).toBeTruthy();
    expect(within(rows[1]!).getByText('An account that no longer exists')).toBeTruthy();
    const limit = screen.getAllByRole('row', { name: /limit\.locations/ })[0]!;
    expect(within(limit).getByText('An override')).toBeTruthy();
  });

  it('with no overrides says the business gets its plan values', async () => {
    serve({});
    panel();
    expect(
      await screen.findByText("No overrides: this business gets its plan's values."),
    ).toBeTruthy();
  });

  it('a suspended business says it is blocked regardless of plan', async () => {
    serve({ org_status: 'suspended' });
    panel();
    await screen.findByText('In good standing');
    expect(screen.getByTestId('billing-why').textContent).toContain('suspended');
    expect(screen.getByTestId('billing-why').textContent).toContain('regardless of its plan');
  });

  it('pending deletion is named too', async () => {
    serve({ org_status: 'pending_deletion' });
    panel();
    await screen.findByText('In good standing');
    expect(screen.getByTestId('billing-why').textContent).toContain('pending deletion');
  });

  it('flags a billed quantity that differs from the locations and lists the unfinished syncs', async () => {
    serve({
      locations_billed: 1,
      locations_wanted: 3,
      locations_actual: 3,
      pending_jobs: [
        {
          status: 'failed',
          attempts: 2,
          next_attempt_at: '2026-11-02T10:00:00Z',
          last_error: 'resource_missing',
          created_at: '2026-11-02T09:00:00Z',
        },
        {
          status: 'queued',
          attempts: 0,
          next_attempt_at: '2026-11-02T11:00:00Z',
          last_error: null,
          created_at: '2026-11-02T10:30:00Z',
        },
      ],
    });
    panel();
    expect(await screen.findByTestId('billing-quantity-mismatch')).toBeTruthy();
    expect(screen.getByText('1 billed, 3 wanted, 3 exist')).toBeTruthy();
    expect(screen.getByText('resource_missing')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();
  });

  it('links only the customer id to Stripe, in a new tab without an opener', async () => {
    serve({});
    panel({ dashboardUrl: 'https://dashboard.stripe.com/test' });
    const link = await screen.findByRole('link', { name: 'Open in Stripe' });
    expect(link.getAttribute('href')).toBe(
      'https://dashboard.stripe.com/test/customers/cus_Abc123',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows no link for a customer id that is not shaped like one', async () => {
    serve({ stripe_customer_id: 'cus_x/../../evil' });
    panel();
    await screen.findByText('In good standing');
    expect(screen.queryByRole('link', { name: 'Open in Stripe' })).toBeNull();
  });

  it('shows the limits exactly as the database resolved them', async () => {
    serve({
      entitlements: [
        { key: 'limit.locations', value: 5, source: 'override' },
        { key: 'paid_channels', value: false, source: 'plan' },
        { key: 'messaging.new_org_days', value: 14, source: 'default' },
      ],
    });
    panel();
    const locations = await screen.findByRole('row', { name: /limit\.locations/ });
    expect(within(locations).getByText('5')).toBeTruthy();
    expect(
      within(screen.getByRole('row', { name: /paid_channels/ })).getByText('false'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('row', { name: /new_org_days/ })).getByText('The default'),
    ).toBeTruthy();
  });

  it('a permission failure shows an error, not an empty panel', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission_denied' } });
    panel();
    expect(
      await screen.findByText("Couldn't load billing. Check your connection and try again."),
    ).toBeTruthy();
    expect(screen.queryByText('In good standing')).toBeNull();
  });
});

const overview: Overview = {
  billing_enabled: true,
  past_due: 2,
  canceled_30d: 1,
  trials_ending_7d: 3,
  attention: [
    { org_id: 'o1', name: 'Acme Barbers', reason: 'past_due', at: '2026-11-10T00:00:00Z' },
    { org_id: 'o2', name: 'Bolt Cafe', reason: 'trial_ending', at: '2026-11-05T00:00:00Z' },
    { org_id: 'o3', name: 'Cedar Spa', reason: 'canceled', at: '2026-10-20T00:00:00Z' },
  ],
};

describe('BillingOverview', () => {
  it('shows the three counts and links each org', async () => {
    m.rpc.mockResolvedValue({ data: overview, error: null });
    show(<BillingOverview />);
    const items = await screen.findAllByTestId('billing-attention');
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByRole('link', { name: 'Acme Barbers' }).getAttribute('href')).toBe(
      '/platform/orgs/o1',
    );
    expect(items[0]!.textContent).toContain('Payment failing, grace ends');
    expect(items[1]!.textContent).toContain('Trial ends');
    expect(items[2]!.textContent).toContain('Canceled');
    const counts = screen.getByText('Past due').parentElement!;
    expect(counts.textContent).toContain('2');
    expect(screen.getByText('Canceled in 30 days').parentElement!.textContent).toContain('1');
    expect(screen.getByText('Trials ending in 7 days').parentElement!.textContent).toContain('3');
  });

  it('says so when nothing needs attention', async () => {
    m.rpc.mockResolvedValue({
      data: { ...overview, past_due: 0, canceled_30d: 0, trials_ending_7d: 0, attention: [] },
      error: null,
    });
    show(<BillingOverview />);
    expect(await screen.findByText('No subscription needs attention.')).toBeTruthy();
  });

  it('renders nothing while billing is off', async () => {
    m.rpc.mockResolvedValue({
      data: { ...overview, billing_enabled: false, past_due: 0, attention: [] },
      error: null,
    });
    const { container } = show(<BillingOverview />);
    await waitFor(() => expect(m.rpc).toHaveBeenCalledWith('platform_billing_overview'));
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('a failed load says so instead of showing zeros', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission_denied' } });
    show(<BillingOverview />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText("Couldn't load the billing overview.")).toBeTruthy();
  });
});

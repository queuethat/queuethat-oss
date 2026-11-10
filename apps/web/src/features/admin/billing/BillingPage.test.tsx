import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { BillingPage } from './BillingPage.tsx';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  role: 'owner',
  fetch: vi.fn(),
  assign: vi.fn(),
  balance: [] as Array<Record<string, unknown>>,
  ledger: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../auth/current.ts', () => ({
  useCurrentOrg: () => ({ id: 'org-a', role: m.role }),
}));
vi.mock('../../../lib/config.ts', async (original) => ({
  ...(await original<typeof import('../../../lib/config.ts')>()),
  appConfig: () => ({ supabaseUrl: 'https://s.test', supabaseAnonKey: 'anon' }),
}));
vi.mock('../../../lib/supabase.ts', () => ({
  supabase: {
    rpc: m.rpc,
    schema: () => ({
      from: (table: string) => {
        const rows = table === 'credit_balance' ? m.balance : m.ledger;
        const chain: Record<string, unknown> = {
          maybeSingle: () => Promise.resolve({ data: m.balance[0] ?? null, error: null }),
          then: (f: (v: unknown) => unknown) =>
            Promise.resolve({ data: rows, error: null }).then(f),
        };
        for (const k of ['select', 'eq', 'neq', 'order', 'limit']) chain[k] = () => chain;
        return chain;
      },
    }),
    auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'jwt' } } }) },
  },
}));

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    unitPriceMinor: 0,
    unitPriceAnnualMinor: null,
    currency: 'usd',
    maxLocations: 1,
    maxMembers: 3,
    paidChannels: false,
  },
  {
    id: 'standard',
    name: 'Standard',
    unitPriceMinor: 1900,
    unitPriceAnnualMinor: 18240,
    currency: 'usd',
    maxLocations: -1,
    maxMembers: -1,
    paidChannels: true,
  },
];

const freeOrg = {
  plan_id: 'free',
  plan_name: 'Free',
  unit_price_minor: 0,
  locations: 1,
  subscribed: false,
  status: null,
  current_period_end: null,
  paid_channels: false,
};

const row = (over: Record<string, unknown> = {}) => ({
  data: [
    {
      enabled: true,
      plan_id: 'standard',
      plan_name: 'Standard',
      unit_price_minor: 1900,
      currency: 'usd',
      locations: 3,
      subscribed: true,
      status: 'active',
      quantity: 3,
      current_period_end: '2026-12-01T00:00:00Z',
      grace_ends_at: null,
      plans: PLANS,
      paid_channels: true,
      billing_interval: 'month',
      ...over,
    },
  ],
  error: null,
});

const view = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BillingPage />
    </QueryClientProvider>,
  );

beforeAll(() => loadNamespaces('admin-billing'));
beforeEach(() => {
  m.role = 'owner';
  m.rpc.mockReset();
  m.fetch.mockReset();
  m.assign.mockReset();
  m.balance = [{ balance_micros: 4_989_000 }];
  m.ledger = [
    {
      id: 'l1',
      created_at: '2026-10-30T10:00:00Z',
      entry_type: 'debit',
      amount_micros: -11000,
      cost_micros: 10000,
      margin_micros: 1000,
    },
  ];
  vi.stubGlobal('fetch', m.fetch);
  Object.defineProperty(window, 'location', { value: { assign: m.assign }, writable: true });
});
afterEach(cleanup);

describe('BillingPage', () => {
  it('AC1: shows nothing but a notice while billing is off', async () => {
    m.rpc.mockResolvedValue(row({ enabled: false }));
    view();
    expect(await screen.findByText(/not available on this deployment/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /manage billing/i })).toBeNull();
  });

  it('shows plan, price per location, total and next invoice, and opens the portal', async () => {
    m.rpc.mockResolvedValue(row());
    m.fetch.mockResolvedValue(Response.json({ url: 'https://billing.stripe.com/s/x' }));
    view();
    expect(await screen.findByText('Standard')).toBeTruthy();
    expect(screen.getAllByText(/\$19\.00 per month/)).toHaveLength(1);
    expect(screen.getByText(/\$57\.00 per month/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /manage billing/i }));
    await waitFor(() => expect(m.assign).toHaveBeenCalledWith('https://billing.stripe.com/s/x'));
    expect(m.fetch.mock.calls[0]?.[0]).toBe('https://s.test/functions/v1/billing/portal');
  });

  it('offers Subscribe to an org without a subscription and opens Checkout', async () => {
    m.rpc.mockResolvedValue(row(freeOrg));
    m.fetch.mockResolvedValue(Response.json({ url: 'https://checkout.stripe.com/c/x' }));
    view();
    await userEvent.click(await screen.findByRole('button', { name: /subscribe/i }));
    await waitFor(() => expect(m.assign).toHaveBeenCalled());
    expect(m.fetch.mock.calls[0]?.[0]).toBe('https://s.test/functions/v1/billing/checkout');
  });

  it('#1082: a free org sees Free beside Standard with price, limits and SMS, current plan marked', async () => {
    m.rpc.mockResolvedValue(row(freeOrg));
    view();
    const table = await screen.findByRole('table', { name: /compare plans/i });
    const cells = (name: RegExp) =>
      within(within(table).getByRole('row', { name }))
        .getAllByRole('cell')
        .map((c) => c.textContent);
    expect(cells(/^Price/)).toEqual([
      '$0.00 per location per month',
      '$19.00 per location per month',
    ]);
    expect(cells(/^Locations/)).toEqual(['1', 'Unlimited']);
    expect(cells(/^Staff seats/)).toEqual(['3', 'Unlimited']);
    expect(cells(/^SMS and WhatsApp/)).toEqual(['Not included', 'Included']);
    expect(within(table).getByRole('columnheader', { name: /free.*current plan/i })).toBeTruthy();
    expect(
      within(table).queryByRole('columnheader', { name: /standard.*current plan/i }),
    ).toBeNull();
  });

  it('#1082: Subscribe states the price from the plan, not a constant', async () => {
    m.rpc.mockResolvedValue(
      row({
        ...freeOrg,
        plans: [PLANS[0], { ...PLANS[1], unitPriceMinor: 2400 }],
      }),
    );
    view();
    expect(
      await screen.findByRole('button', { name: 'Subscribe for $24.00 per location per month' }),
    ).toBeTruthy();
  });

  it('#1085: an annual toggle reprices the comparison and Subscribe, and Checkout is asked for the year', async () => {
    m.rpc.mockResolvedValue(row(freeOrg));
    m.fetch.mockResolvedValue(Response.json({ url: 'https://checkout.stripe.com/c/y' }));
    view();
    await screen.findByRole('table', { name: /compare plans/i });
    expect((screen.getByRole('radio', { name: 'Monthly' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'Annual' }));
    const table = screen.getByRole('table', { name: /compare plans/i });
    expect(within(table).getByText('$182.40 per location per year')).toBeTruthy();
    expect(screen.getByText('Save 20% with annual billing')).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Subscribe for $182.40 per location per year' }),
    );
    await waitFor(() => expect(m.assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/y'));
    expect(m.fetch.mock.calls[0]?.[0]).toBe('https://s.test/functions/v1/billing/checkout');
    expect(JSON.parse(String((m.fetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      org_id: 'org-a',
      interval: 'year',
    });
  });

  it('#1085: monthly Checkout names the month; no toggle without an annual price', async () => {
    m.rpc.mockResolvedValue(
      row({ ...freeOrg, plans: [PLANS[0], { ...PLANS[1], unitPriceAnnualMinor: null }] }),
    );
    m.fetch.mockResolvedValue(Response.json({ url: 'https://checkout.stripe.com/c/m' }));
    view();
    await userEvent.click(await screen.findByRole('button', { name: /^subscribe for/i }));
    await waitFor(() => expect(m.assign).toHaveBeenCalled());
    expect(JSON.parse(String((m.fetch.mock.calls[0]?.[1] as RequestInit).body)).interval).toBe(
      'month',
    );
    expect(screen.queryByRole('radio', { name: 'Annual' })).toBeNull();
  });

  it('#1085: an annual subscriber sees the yearly price and total', async () => {
    m.rpc.mockResolvedValue(row({ billing_interval: 'year' }));
    view();
    await screen.findByText('Standard');
    expect(screen.getAllByText('$182.40 per year')).toHaveLength(1);
    expect(screen.getByText('$547.20 per year')).toBeTruthy();
  });

  it('#1082: a subscribed org does not see the comparison', async () => {
    m.rpc.mockResolvedValue(row());
    view();
    await screen.findByText('Standard');
    expect(screen.queryByRole('table', { name: /compare plans/i })).toBeNull();
  });

  it('#1082: the SMS credit card is hidden while paid channels are not allowed', async () => {
    m.rpc.mockResolvedValue(row(freeOrg));
    view();
    await screen.findByRole('table', { name: /compare plans/i });
    expect(screen.queryByText(/SMS credit/)).toBeNull();
    expect(screen.queryByRole('button', { name: /add \$25\.00/i })).toBeNull();
  });

  it('#1082: the free page has no serious accessibility violations', async () => {
    m.rpc.mockResolvedValue(row(freeOrg));
    const { container } = view();
    await screen.findByRole('table', { name: /compare plans/i });
    const results = await axe.run(container);
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
  });

  it('explains a failed payment without alarm: nothing changes yet, data is kept', async () => {
    m.rpc.mockResolvedValue(row({ status: 'past_due', grace_ends_at: '2026-11-14T00:00:00Z' }));
    view();
    expect((await screen.findByTestId('billing-banner')).textContent).toMatch(/never deleted/);
  });

  it('AC2: a non-owner sees no billing and the database is never asked', async () => {
    m.role = 'admin';
    view();
    expect(await screen.findByText(/only the owner/i)).toBeTruthy();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('shows the SMS credit balance with cost and margin apart, and a top-up opens Checkout for the chosen amount', async () => {
    m.rpc.mockResolvedValue(row());
    m.fetch.mockResolvedValue(Response.json({ url: 'https://checkout.stripe.com/c/t' }));
    view();
    expect(await screen.findByText(/Balance: \$4\.989/)).toBeTruthy();
    expect(screen.getByText('$0.01')).toBeTruthy();
    expect(screen.getByText('$0.001')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /add \$25\.00/i }));
    await waitFor(() => expect(m.assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/t'));
    expect(m.fetch.mock.calls[0]?.[0]).toBe('https://s.test/functions/v1/billing/topup');
    expect(JSON.parse(String((m.fetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      org_id: 'org-a',
      amount_minor: 2500,
    });
  });

  it('shows an error when Stripe cannot be opened', async () => {
    m.rpc.mockResolvedValue(row());
    m.fetch.mockResolvedValue(Response.json({ error: 'provider' }, { status: 502 }));
    view();
    await userEvent.click(await screen.findByRole('button', { name: /manage billing/i }));
    expect(await screen.findByText(/could not open billing/i)).toBeTruthy();
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { DELIVERIES_PAGE, type Delivery } from './api.ts';
import { DeliveryLog } from './DeliveryLog.tsx';
import { MessagesPage } from './MessagesPage.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => <a href={`/platform/orgs/${params?.orgId ?? ''}`}>{children}</a>,
}));
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => m.rpc.mockReset());
afterEach(cleanup);

function show(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const row = (over: Partial<Delivery> = {}): Delivery => ({
  kind: 'message',
  id: 'id-1',
  org_id: 'org-1',
  org_name: 'Acme Barbers',
  created_at: '2026-03-10T09:00:00Z',
  updated_at: '2026-03-10T09:00:00Z',
  medium: 'sms',
  template_key: 'called',
  status: 'sent',
  delivery_status: null,
  error_code: null,
  attempts: 1,
  provider: 'twilio',
  suppression_reason: null,
  recipient_masked: '******23',
  ...over,
});

describe('DeliveryLog', () => {
  it('shows sent, failed and suppressed rows with plain reasons and masked recipients', async () => {
    m.rpc.mockResolvedValue({
      data: [
        row({ id: 'a' }),
        row({
          id: 'b',
          status: 'failed',
          error_code: 'http_503',
          recipient_masked: 'z***@example.com',
          medium: 'email',
          provider: 'resend',
        }),
        row({
          id: 'c',
          status: 'suppressed',
          error_code: 'suppressed',
          suppression_reason: 'stop',
        }),
        row({ id: 'd', status: 'dead', error_code: 'twilio_30003' }),
        row({ id: 'e', medium: 'push', recipient_masked: null }),
      ],
      error: null,
    });
    show(<DeliveryLog orgId="org-1" />);
    expect(await screen.findByText('z***@example.com')).toBeTruthy();
    expect(screen.getByText('The receiver answered with error 503')).toBeTruthy();
    expect(screen.getByText(/replied STOP or unsubscribed/)).toBeTruthy();
    expect(screen.getByText('Other: twilio_30003')).toBeTruthy();
    expect(screen.getByText('Not shown')).toBeTruthy();
    // No raw code is shown where a plain sentence exists.
    expect(screen.queryByText('http_503')).toBeNull();
    expect(m.rpc).toHaveBeenCalledWith(
      'platform_org_deliveries',
      expect.objectContaining({ p_org_id: 'org-1', p_limit: DELIVERIES_PAGE }),
    );
  });

  it('says so when an org has no messages, and when the load fails', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    show(<DeliveryLog orgId="org-1" />);
    expect(await screen.findByText('Nothing in this period.')).toBeTruthy();
    cleanup();
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission_denied' } });
    show(<DeliveryLog orgId="org-1" />);
    expect(await screen.findByText(/load this/i)).toBeTruthy();
  });

  it('pages with the last row as the cursor, and stops after a short page', async () => {
    const full = Array.from({ length: DELIVERIES_PAGE }, (_, i) =>
      row({ id: `r${i}`, created_at: `2026-03-10T09:${String(59 - i).padStart(2, '0')}:00Z` }),
    );
    m.rpc
      .mockResolvedValueOnce({ data: full, error: null })
      .mockResolvedValueOnce({ data: [row({ id: 'last' })], error: null });
    show(<DeliveryLog orgId="org-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(2));
    expect(m.rpc.mock.calls[1]![1]).toMatchObject({
      p_after_at: full[DELIVERIES_PAGE - 1]!.created_at,
      p_after_id: `r${DELIVERIES_PAGE - 1}`,
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull());
  });

  it('shows no "Show older" button when the page is exactly short of full', async () => {
    m.rpc.mockResolvedValue({ data: [row()], error: null });
    show(<DeliveryLog orgId="org-1" />);
    await screen.findByText('******23');
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });

  it('sends the chosen filters, with times as ISO instants', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    show(<DeliveryLog orgId="org-1" />);
    await screen.findByText('Nothing in this period.');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed');
    await userEvent.selectOptions(screen.getByLabelText('Channel'), 'sms');
    await userEvent.type(screen.getByLabelText('From'), '2026-03-10T09:00');
    const last = () => m.rpc.mock.calls.at(-1)![1] as Record<string, unknown>;
    await waitFor(() => expect(last()).toMatchObject({ p_status: 'failed', p_channel: 'sms' }));
    await waitFor(() => expect(last().p_from).toBe(new Date('2026-03-10T09:00').toISOString()));
  });

  it('does not query when the start is not before the end', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    show(<DeliveryLog orgId="org-1" />);
    await screen.findByText('Nothing in this period.');
    const before = m.rpc.mock.calls.length;
    await userEvent.type(screen.getByLabelText('From'), '2026-03-10T09:00');
    await userEvent.type(screen.getByLabelText('Until (not included)'), '2026-03-10T09:00');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('before the end');
    const calls = m.rpc.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(before);
    expect(m.rpc.mock.calls.at(-1)![1]).not.toMatchObject({
      p_to: new Date('2026-03-10T09:00').toISOString(),
      p_from: new Date('2026-03-10T09:00').toISOString(),
    });
  });

  it('all-businesses view starts on failures, offers only problem statuses, and links each business', async () => {
    m.rpc.mockResolvedValue({
      data: [row({ status: 'failed', error_code: 'rate_limited' })],
      error: null,
    });
    show(<DeliveryLog orgId={null} />);
    const link = await screen.findByRole('link', { name: 'Acme Barbers' });
    expect(link.getAttribute('href')).toBe('/platform/orgs/org-1');
    const options = within(screen.getByLabelText('Status'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Failed', 'Gave up', 'Held back']);
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_status: 'failed' });
    expect(m.rpc.mock.calls[0]![1]).not.toHaveProperty('p_from');
  });
});

describe('MessagesPage', () => {
  it('shows the rate by channel and provider and the failures below it', async () => {
    m.rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'platform_delivery_summary'
          ? {
              data: [
                {
                  medium: 'sms',
                  provider: 'twilio',
                  sent: 90,
                  failed: 10,
                  suppressed: 2,
                  pending: 1,
                  failure_rate: 0.1,
                },
                {
                  medium: 'webhook',
                  provider: 'webhook',
                  sent: 0,
                  failed: 0,
                  suppressed: 0,
                  pending: 0,
                  failure_rate: 0,
                },
              ],
              error: null,
            }
          : { data: [row({ status: 'failed', error_code: 'rate_limited' })], error: null },
      ),
    );
    show(<MessagesPage now={Date.parse('2026-03-11T00:00:00Z')} />);
    const table = await screen.findByRole('table', { name: /Last 7 days, all businesses/ });
    const cells = within(table).getAllByRole('row')[1]!;
    expect(within(cells).getByText('twilio')).toBeTruthy();
    expect(within(cells).getByText('10%')).toBeTruthy();
    expect(m.rpc).toHaveBeenCalledWith('platform_delivery_summary', {
      p_from: '2026-03-04T00:00:00.000Z',
      p_to: '2026-03-11T00:00:00.000Z',
    });
    expect(await screen.findByText('The provider or our limits slowed this down')).toBeTruthy();
  });

  it('says there was no traffic for an empty period', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    show(<MessagesPage now={Date.parse('2026-03-11T00:00:00Z')} />);
    expect(await screen.findByText('No messages in this period.')).toBeTruthy();
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { AttentionQueue } from './AttentionQueue.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: React.ReactNode; params: { orgId: string } }) => (
    <a href={`/platform/orgs/${params.orgId}`}>{children}</a>
  ),
}));

beforeAll(() => loadNamespaces('platform'));
afterEach(cleanup);

const row = (over: Record<string, unknown> = {}) => ({
  org_id: 'org-1',
  name: 'Demo Barber',
  org_status: 'active',
  reason: 'support_request_open',
  priority: 1,
  since: '2026-11-02T10:00:00Z',
  detail: { count: 2 },
  total: 2,
  ...over,
});

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AttentionQueue />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  m.rpc.mockReset();
  m.rpc.mockImplementation(async (fn: string) =>
    fn === 'platform_attention'
      ? {
          data: [
            row(),
            row({
              org_id: 'org-2',
              name: 'Other Salon',
              reason: 'stuck_onboarding',
              priority: 9,
              detail: { stage: 'queue_created', days: 5 },
            }),
          ],
          error: null,
        }
      : { data: null, error: null },
  );
});

describe('AttentionQueue', () => {
  it('lists the database order with the total and each reason in words', async () => {
    show();
    const items = await screen.findAllByTestId('attention-item');
    expect(items).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Needs attention (2)' })).toBeTruthy();
    expect(within(items[0]!).getByRole('link', { name: 'Demo Barber' }).getAttribute('href')).toBe(
      '/platform/orgs/org-1',
    );
    expect(items[0]!.textContent).toContain('has open support requests (2)');
    expect(items[1]!.textContent).toContain('stuck at Queue created for 5 days');
    expect(m.rpc).toHaveBeenCalledWith('platform_attention', { p_limit: 50 });
  });

  it('words an automatic SMS pause with the SMS panel reason and falls back for an unknown rule', async () => {
    m.rpc.mockResolvedValue({
      data: [
        row({ reason: 'sms_auto_paused', detail: { why: 'stop_rate' } }),
        row({ org_id: 'org-3', name: 'Newer', reason: 'brand_new_rule', detail: {} }),
      ],
      error: null,
    });
    show();
    const items = await screen.findAllByTestId('attention-item');
    expect(items[0]!.textContent).toContain('paused automatically (too many STOP replies)');
    expect(items[1]!.textContent).toContain('needs a look');
  });

  it('words a tagged tenant with its tags', async () => {
    m.rpc.mockResolvedValue({
      data: [
        row({ reason: 'tagged_attention', detail: { tags: ['billing-issue', 'churn-risk'] } }),
      ],
      error: null,
    });
    show();
    const item = await screen.findByTestId('attention-item');
    expect(item.textContent).toContain('tagged by a teammate: billing-issue, churn-risk');
  });

  it('hides an item for a day or a week through the acknowledge call and reloads', async () => {
    const user = userEvent.setup();
    show();
    const first = (await screen.findAllByTestId('attention-item'))[0]!;
    await user.click(within(first).getByRole('button', { name: 'Hide for a week' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_ack_attention', {
        p_org_id: 'org-1',
        p_reason: 'support_request_open',
        p_hours: 168,
      }),
    );
    await user.click(within(first).getByRole('button', { name: 'Hide for a day' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_ack_attention', {
        p_org_id: 'org-1',
        p_reason: 'support_request_open',
        p_hours: 24,
      }),
    );
    const loads = m.rpc.mock.calls.filter(([fn]) => fn === 'platform_attention').length;
    expect(loads).toBeGreaterThan(1);
  });

  it('says nothing needs attention only when the call succeeded with no rows', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    show();
    expect(await screen.findByText('Nothing needs attention right now.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Needs attention (0)' })).toBeTruthy();
  });

  it('shows an error, never the all-clear, when the call fails', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'permission_denied', code: '42501' } });
    show();
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load");
    expect(screen.queryByText('Nothing needs attention right now.')).toBeNull();
  });

  it('reports a failed acknowledge and keeps the item', async () => {
    m.rpc.mockImplementation(async (fn: string) =>
      fn === 'platform_attention'
        ? { data: [row()], error: null }
        : { data: null, error: { message: 'x', code: 'P0001' } },
    );
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Hide for a day' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't hide");
    expect(screen.getAllByTestId('attention-item')).toHaveLength(1);
  });
});

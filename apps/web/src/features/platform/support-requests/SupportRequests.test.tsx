import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { SupportRequests } from './SupportRequests.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

beforeAll(() => loadNamespaces('platform'));
afterEach(cleanup);

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  reference: 'SR-000007',
  user_id: 'u1',
  user_email: 'staff@demo.test',
  subject: 'Blank screen',
  message: 'The page is blank.\nSecond line.',
  context: {
    route: '/admin/queues',
    app_version: '20261102010101',
    browser: 'Mozilla/5.0 Test',
    viewport: { w: 1024, h: 768 },
    online: true,
    plan: 'standard',
    role: 'staff',
    last_error_id: 'err_123',
  },
  status: 'open',
  created_at: '2026-11-02T10:00:00Z',
  closed_at: null,
  ...over,
});

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SupportRequests orgId="org-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  m.rpc.mockReset();
  m.rpc.mockImplementation(async (fn: string) =>
    fn === 'platform_list_support_requests'
      ? { data: [row()], error: null }
      : { data: null, error: null },
  );
});

describe('SupportRequests', () => {
  it('shows each request with its context beside the message', async () => {
    show();
    const item = await screen.findByTestId('support-request-SR-000007');
    expect(m.rpc).toHaveBeenCalledWith('platform_list_support_requests', { p_org_id: 'org-1' });
    for (const text of [
      'Blank screen',
      'staff@demo.test (staff)',
      '/admin/queues',
      '20261102010101',
      '1024 × 768',
      'err_123',
      'standard',
      'Open',
    ]) {
      expect(within(item).getByText(text, { exact: false })).toBeTruthy();
    }
    expect(within(item).getByText(/The page is blank\./).textContent).toContain('Second line.');
  });

  it('renders a message as text, never as markup', async () => {
    m.rpc.mockResolvedValue({
      data: [row({ message: '<img src=x onerror=alert(1)><b>hi</b>' })],
      error: null,
    });
    show();
    const item = await screen.findByTestId('support-request-SR-000007');
    expect(item.querySelector('img')).toBeNull();
    expect(item.querySelector('b')).toBeNull();
    expect(item.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('closes a request and reloads the list', async () => {
    const user = userEvent.setup();
    show();
    const item = await screen.findByTestId('support-request-SR-000007');
    await user.click(within(item).getByRole('button', { name: 'Close request' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('platform_set_support_request_status', {
        p_request_id: 'r1',
        p_status: 'closed',
      }),
    );
    await waitFor(() =>
      expect(
        m.rpc.mock.calls.filter(([fn]) => fn === 'platform_list_support_requests').length,
      ).toBeGreaterThan(1),
    );
  });

  it('offers Reopen on a closed request', async () => {
    m.rpc.mockResolvedValue({
      data: [row({ status: 'closed', closed_at: '2026-11-02T11:00:00Z' })],
      error: null,
    });
    show();
    const item = await screen.findByTestId('support-request-SR-000007');
    expect(within(item).getByText('Closed')).toBeTruthy();
    expect(within(item).getByRole('button', { name: 'Reopen' })).toBeTruthy();
  });

  it('says so when there are none, and when the list or an action fails', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    show();
    expect(await screen.findByText('No support requests from this business.')).toBeTruthy();
    cleanup();
    m.rpc.mockResolvedValue({ data: null, error: { message: 'permission_denied', code: '42501' } });
    show();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't load/);
  });

  it('reports a failed close', async () => {
    m.rpc.mockImplementation(async (fn: string) =>
      fn === 'platform_list_support_requests'
        ? { data: [row()], error: null }
        : { data: null, error: { message: 'not_found', code: 'P0001' } },
    );
    const user = userEvent.setup();
    show();
    const item = await screen.findByTestId('support-request-SR-000007');
    await user.click(within(item).getByRole('button', { name: 'Close request' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't change/);
  });
});

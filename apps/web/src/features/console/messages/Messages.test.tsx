import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { MessagesTimeline } from './Messages.tsx';

vi.mock('../../auth/current.ts', () => ({
  useCurrentLocation: () => ({ location: null }),
  useCurrentOrg: () => null,
}));
const rpc = vi.fn();
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const row = (o: Record<string, unknown>) => ({
  id: 'n1',
  visit_id: 'v1',
  channel: 'sms',
  template: 'called',
  status: 'sent',
  attempts: 1,
  last_error: null,
  created_at: '2026-10-30T10:00:00Z',
  sent_at: null,
  delivered_at: null,
  ...o,
});

function setup(canRetry: boolean, textState?: 'opted_out' | 'no_consent' | 'on') {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MessagesTimeline visitId="v1" timeZone="UTC" canRetry={canRetry} textState={textState} />
    </QueryClientProvider>,
  );
}

beforeAll(() => loadNamespaces('staff'));
afterEach(cleanup);

describe('MessagesTimeline', () => {
  beforeEach(() => rpc.mockReset());

  it('lists each message with its channel and status', async () => {
    rpc.mockResolvedValue({
      data: [row({}), row({ id: 'n2', channel: 'push', status: 'suppressed' })],
      error: null,
    });
    setup(false);
    await waitFor(() => expect(screen.getAllByTestId('message-row')).toHaveLength(2));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers retry on a dead message to managers only', async () => {
    rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'list_visit_notifications'
          ? { data: [row({ status: 'dead', last_error: 'timeout' })], error: null }
          : { data: row({ status: 'queued' }), error: null },
      ),
    );
    setup(true);
    await userEvent.click(await screen.findByRole('button'));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'retry_notification',
        expect.objectContaining({
          p_notification_id: 'n1',
        }),
      ),
    );
  });

  it('disables retry of a dead text for an opted-out guest and says why (3-CG10)', async () => {
    rpc.mockResolvedValue({ data: [row({ status: 'dead', last_error: 'timeout' })], error: null });
    setup(true, 'opted_out');
    const button = await screen.findByRole('button', { name: 'Retry' });
    expect(button.hasAttribute('disabled')).toBe(true);
    const why = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toMatch(/opted out of texts/);
  });

  it('still retries a dead push for an opted-out guest, and a text for a guest with consent', async () => {
    rpc.mockResolvedValue({
      data: [row({ status: 'dead', channel: 'push' })],
      error: null,
    });
    setup(true, 'opted_out');
    expect((await screen.findByRole('button', { name: 'Retry' })).hasAttribute('disabled')).toBe(
      false,
    );
    cleanup();
    rpc.mockResolvedValue({ data: [row({ status: 'dead' })], error: null });
    setup(true, 'on');
    expect((await screen.findByRole('button', { name: 'Retry' })).hasAttribute('disabled')).toBe(
      false,
    );
  });
});

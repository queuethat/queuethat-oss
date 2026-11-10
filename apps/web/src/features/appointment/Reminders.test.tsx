import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { Reminders } from './Reminders.tsx';

const m = vi.hoisted(() => ({
  support: 'available' as string,
  subscribe: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../guest/push.ts', () => ({
  pushSupport: () => m.support,
  isIOS: () => false,
  subscribeToPush: m.subscribe,
}));
vi.mock('../guest/client.ts', () => ({ guestRpc: m.rpc }));

function show() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Reminders token="apt-1" />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await loadNamespaces('booking');
  m.support = 'available';
  m.subscribe.mockResolvedValue({
    endpoint: 'https://fcm.googleapis.com/x',
    p256dh: 'p',
    auth: 'a',
  });
  m.rpc.mockResolvedValue(null);
  localStorage.clear();
});
afterEach(cleanup);

describe('Reminders', () => {
  it('registers the browser for this appointment and says reminders are on', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Remind me' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Reminders are on/));
    expect(m.rpc).toHaveBeenCalledWith('guest_register_appointment_push', {
      p_token: 'apt-1',
      p_endpoint: 'https://fcm.googleapis.com/x',
      p_p256dh: 'p',
      p_auth: 'a',
    });
  });

  it('hides the opt-in in a browser without push and says so plainly', () => {
    m.support = 'unavailable';
    show();
    expect(screen.queryByRole('button', { name: 'Remind me' })).toBeNull();
    expect(screen.getByText(/can't show reminders/)).toBeTruthy();
  });

  it('is honest about the iPhone Home Screen requirement', () => {
    m.support = 'needs_home_screen';
    show();
    expect(screen.queryByRole('button', { name: 'Remind me' })).toBeNull();
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
  });
});

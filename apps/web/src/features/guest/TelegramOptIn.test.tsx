import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { TelegramOptIn } from './TelegramOptIn.tsx';

const m = vi.hoisted(() => ({ bot: 'qm_test_bot', rpc: vi.fn() }));
vi.mock('../../lib/config.ts', () => ({ appConfig: () => ({ telegramBot: m.bot }) }));
vi.mock('./client.ts', () => ({ guestRpc: m.rpc, guestFunction: vi.fn() }));

beforeAll(() => loadNamespaces('guest', 'guest-status'));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <TelegramOptIn token="tok-1" />
    </QueryClientProvider>,
  );
}

describe('TelegramOptIn', () => {
  it('renders nothing when the deployment has no bot', () => {
    m.bot = '';
    const { container } = show();
    expect(container.innerHTML).toBe('');
    m.bot = 'qm_test_bot';
  });

  it('mints a link and opens it', async () => {
    m.rpc.mockResolvedValue({ deep_link: 'https://t.me/qm_test_bot?start=abc', expires_at: 'x' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Get updates on Telegram' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://t.me/qm_test_bot?start=abc', '_blank', 'noopener'),
    );
    expect(m.rpc).toHaveBeenCalledWith('guest_create_link_code', {
      p_token: 'tok-1',
      p_channel: 'telegram',
    });
    expect((await screen.findByRole('status')).textContent).toContain('Tap Start');
  });

  it('says so when the database has no bot configured', async () => {
    m.rpc.mockRejectedValue(new Error('invalid_input'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Get updates on Telegram' }));
    expect((await screen.findByRole('alert')).textContent).toContain("aren't available");
  });
});

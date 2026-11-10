import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { WhatsAppButton } from './WhatsAppButton.tsx';

const rpc = vi.fn();
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

function setup() {
  const tab = { location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WhatsAppButton visitId="v1" ticket="A012" />
    </QueryClientProvider>,
  );
  return tab;
}

beforeAll(() => loadNamespaces('staff'));
afterEach(cleanup);

describe('WhatsAppButton', () => {
  beforeEach(() => rpc.mockReset());

  it('logs the tap, then opens the wa.me link with the ticket', async () => {
    rpc.mockResolvedValue({ data: '+447700900123', error: null });
    const tab = setup();
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(tab.location.href).toMatch(/^https:\/\/wa\.me\/447700900123\?text=/),
    );
    expect(decodeURIComponent(tab.location.href)).toContain('A012');
    expect(rpc).toHaveBeenCalledWith('log_manual_contact', {
      p_visit_id: 'v1',
      p_channel: 'whatsapp',
    });
  });

  it('disables itself when the number is opted out', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'suppressed' } });
    const tab = setup();
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true),
    );
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertPrefs } from './AlertPrefs.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./client.ts', () => ({ guestRpc: m.rpc }));

let saved: string[];

beforeEach(() => {
  saved = ['called', 'almost_up'];
  m.rpc.mockImplementation(async (fn: string, args: { p_triggers?: string[] }) => {
    if (fn === 'guest_set_alert_prefs') saved = args.p_triggers!;
    return { triggers: saved, available: ['called', 'almost_up', 'position_changed'] };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AlertPrefs token="tok-1" />
    </QueryClientProvider>,
  );
}

async function open() {
  fireEvent.click(await screen.findByRole('button', { name: 'Choose your alerts' }));
}

describe('AlertPrefs', () => {
  it('lists the alerts the database offers, each with an accessible name and state', async () => {
    show();
    await open();
    expect(screen.getByRole('checkbox', { name: "It's my turn" })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: "I'm almost up" })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'My place in line changes' })).toHaveProperty(
      'checked',
      false,
    );
  });

  it('saves a change at once and keeps it when the list is read again (AC1)', async () => {
    show();
    await open();
    fireEvent.click(screen.getByRole('checkbox', { name: 'My place in line changes' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith(
        'guest_set_alert_prefs',
        expect.objectContaining({
          p_token: 'tok-1',
          p_triggers: ['called', 'almost_up', 'position_changed'],
        }),
      ),
    );
    expect(
      await screen.findByRole('checkbox', { name: 'My place in line changes' }),
    ).toHaveProperty('checked', true);
  });

  it('warns, but allows it, when "It\'s my turn" is turned off', async () => {
    show();
    await open();
    expect(screen.queryByText(/Without this one/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: "It's my turn" }));
    expect((await screen.findByRole('status')).textContent).toContain("won't be told");
    await waitFor(() => expect(saved).toEqual(['almost_up']));
  });

  it('restores the old choice and says so when saving fails', async () => {
    show();
    await open();
    m.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'guest_set_alert_prefs') throw new Error('rate_limited');
      return { triggers: ['called', 'almost_up'], available: ['called', 'almost_up'] };
    });
    fireEvent.click(screen.getByRole('checkbox', { name: "I'm almost up" }));
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't save");
    expect(screen.getByRole('checkbox', { name: "I'm almost up" })).toHaveProperty('checked', true);
  });

  it('renders nothing when the visit has no alerts to choose from', async () => {
    m.rpc.mockResolvedValue({ triggers: [], available: [] });
    const { container } = show();
    await waitFor(() => expect(m.rpc).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

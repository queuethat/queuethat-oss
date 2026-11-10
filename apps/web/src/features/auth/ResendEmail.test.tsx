import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { queryClient } from '../../lib/query.ts';
import { createAppRouter } from '../../router.tsx';

// S2 (#1106): the sign-up code screen counts down, then points an existing account at sign-in
// and lets the person ask for another email.

const m = vi.hoisted(() => ({ signUp: vi.fn(), resend: vi.fn() }));
vi.mock('../../lib/supabase.ts', () => ({
  supabase: {
    auth: {
      signUp: m.signUp,
      resend: m.resend,
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(),
    },
  },
}));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  m.signUp.mockReset().mockResolvedValue({ error: null });
  m.resend.mockReset().mockResolvedValue({ error: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function signUp() {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/auth/sign-up'] }));
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  fireEvent.change(await screen.findByLabelText('Email'), {
    target: { value: 'owner@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByLabelText('8-digit code');
}

async function waitOutTheCountdown() {
  for (let i = 0; i < 60; i += 1) await act(async () => void vi.advanceTimersByTime(1000));
}

it('counts down, then shows the way out and a working resend', async () => {
  await signUp();
  const resend = screen.getByRole('button', { name: 'Resend email' }) as HTMLButtonElement;
  expect(resend.disabled).toBe(true);
  expect(screen.getByText(/ask for another email in \d+ seconds/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Forgot password?' })).toBeNull();

  await waitOutTheCountdown();
  await waitFor(() => expect(resend.disabled).toBe(false));
  expect(screen.getByRole('link', { name: 'Sign in instead' }).getAttribute('href')).toContain(
    '/auth/sign-in',
  );
  expect(screen.getByRole('link', { name: 'Forgot password?' })).toBeTruthy();

  fireEvent.click(resend);
  await waitFor(() => expect(m.resend).toHaveBeenCalledTimes(1));
  expect(m.resend.mock.calls[0]![0]).toMatchObject({
    type: 'signup',
    email: 'owner@example.test',
  });
  // Sent: the wait starts again and the person is told to use the newest email.
  expect(await screen.findByText(/Sent again/)).toBeTruthy();
  expect(resend.disabled).toBe(true);
});

it('shows the rate-limit message when Auth throttles the resend', async () => {
  await signUp();
  await waitOutTheCountdown();
  m.resend.mockResolvedValueOnce({ error: { code: 'over_email_send_rate_limit', message: 'x' } });
  const resend = screen.getByRole('button', { name: 'Resend email' }) as HTMLButtonElement;
  await waitFor(() => expect(resend.disabled).toBe(false));
  fireEvent.click(resend);
  expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
});

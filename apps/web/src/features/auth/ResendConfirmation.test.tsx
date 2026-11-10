import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { queryClient } from '../../lib/query.ts';
import { createAppRouter } from '../../router.tsx';

// S4 (#1107): only an unconfirmed account gets a "Resend confirmation email" button on sign-in.

const m = vi.hoisted(() => ({ signIn: vi.fn(), resend: vi.fn() }));
vi.mock('../../lib/supabase.ts', () => ({
  supabase: {
    auth: {
      signInWithPassword: m.signIn,
      resend: m.resend,
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(),
    },
  },
}));

beforeEach(() => {
  m.signIn.mockReset();
  m.resend.mockReset().mockResolvedValue({ error: null });
});
afterEach(cleanup);

async function signIn(error: { code: string; message: string }) {
  m.signIn.mockResolvedValue({ error });
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/auth/sign-in'] }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

it('offers a resend for an unconfirmed account and then asks for the code', async () => {
  await signIn({ code: 'email_not_confirmed', message: 'x' });
  fireEvent.click(await screen.findByRole('button', { name: 'Resend confirmation email' }));
  await waitFor(() => expect(m.resend).toHaveBeenCalledTimes(1));
  expect(m.resend.mock.calls[0]![0]).toMatchObject({ type: 'signup', email: 'owner@example.test' });
  expect(await screen.findByLabelText('8-digit code')).toBeTruthy();
});

it('offers nothing extra for a wrong password', async () => {
  await signIn({ code: 'invalid_credentials', message: 'x' });
  await screen.findByText(/don't match/);
  expect(screen.queryByRole('button', { name: 'Resend confirmation email' })).toBeNull();
});

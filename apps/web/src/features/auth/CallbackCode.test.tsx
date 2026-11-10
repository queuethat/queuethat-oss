import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { queryClient } from '../../lib/query.ts';
import { createAppRouter } from '../../router.tsx';

// S8 (#1109): a link that fails in this browser leaves a way in: a fresh code, asked for right there.

const m = vi.hoisted(() => ({ verify: vi.fn(), otp: vi.fn(), reset: vi.fn() }));
vi.mock('../../lib/supabase.ts', () => ({
  supabase: {
    auth: {
      verifyOtp: m.verify,
      signInWithOtp: m.otp,
      resetPasswordForEmail: m.reset,
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(),
    },
  },
}));

beforeEach(() => {
  m.verify.mockReset().mockResolvedValue({ error: null });
  m.otp.mockReset().mockResolvedValue({ error: null });
  m.reset.mockReset().mockResolvedValue({ error: null });
});
afterEach(cleanup);

async function open(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function ask(button: string) {
  fireEvent.change(await screen.findByLabelText('Email'), {
    target: { value: 'owner@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: button }));
  await screen.findByLabelText('8-digit code');
}

it('a failed link offers a fresh sign-in code, then verifies it as a sign-in code', async () => {
  await open('/auth/callback?error_code=otp_expired&next=%2Fstaff');
  await ask('Email me a sign-in code');
  expect(m.otp.mock.calls[0]![0]).toMatchObject({
    email: 'owner@example.test',
    options: { shouldCreateUser: false },
  });
  fireEvent.change(screen.getByLabelText('8-digit code'), { target: { value: '12345678' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue with code' }));
  await waitFor(() => expect(m.verify).toHaveBeenCalledTimes(1));
  expect(m.verify.mock.calls[0]![0]).toMatchObject({ type: 'email', token: '12345678' });
});

it('a failed password-reset link offers a reset code instead', async () => {
  await open('/auth/callback?error_code=otp_expired&next=%2Fauth%2Freset-password');
  await ask('Email me a reset code');
  expect(m.reset).toHaveBeenCalledTimes(1);
  expect(m.otp).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('8-digit code'), { target: { value: '12345678' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue with code' }));
  await waitFor(() => expect(m.verify).toHaveBeenCalledTimes(1));
  expect(m.verify.mock.calls[0]![0]).toMatchObject({ type: 'recovery' });
});

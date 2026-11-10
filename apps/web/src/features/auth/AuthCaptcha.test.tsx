import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../lib/query.ts';
import { createAppRouter } from '../../router.tsx';

// #76: the sign-in and sign-up pages send Cloudflare Turnstile tokens to Supabase Auth only when
// a site key is configured, and a token is never reused.

const m = vi.hoisted(() => ({ signIn: vi.fn(), signUp: vi.fn(), otp: vi.fn(), broken: false }));
vi.mock('../../lib/supabase.ts', () => ({
  supabase: {
    auth: {
      signInWithPassword: m.signIn,
      signUp: m.signUp,
      signInWithOtp: m.otp,
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(),
    },
  },
}));
// The real widget loads Cloudflare's script. This stand-in solves instantly, with a new token
// for each round, the way a fresh challenge would.
vi.mock('../../components/Turnstile.tsx', () => ({
  Turnstile: ({
    round,
    onToken,
    onProblem,
  }: {
    round: number;
    onToken: (token: string | null) => void;
    onProblem: (problem: boolean) => void;
  }) => {
    useEffect(() => {
      // `broken` is the blocked-script case: no token, ever, and the widget says so (#576).
      if (m.broken) onProblem(true);
      else onToken(`token-${round}`);
    }, [round, onToken, onProblem]);
    return <div role="group" aria-label="Checking you're not a robot" />;
  },
}));

async function open(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function fill(email = 'owner@example.test', password = 'password123') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
}

beforeEach(() => {
  m.signIn.mockReset().mockResolvedValue({ error: null });
  m.signUp.mockReset().mockResolvedValue({ error: null });
  m.otp.mockReset().mockResolvedValue({ error: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  m.broken = false;
});

describe('without a site key', () => {
  it('shows no widget and sends no token', async () => {
    await open('/auth/sign-in');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByRole('group', { name: /robot/ })).toBeNull();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(m.signIn).toHaveBeenCalled());
    expect(m.signIn).toHaveBeenCalledWith({
      email: 'owner@example.test',
      password: 'password123',
      options: {},
    });
  });
});

describe('with a site key', () => {
  beforeEach(() => vi.stubEnv('VITE_AUTH_TURNSTILE_SITE_KEY', '1x00000000000000000000AA'));

  it('sign-in sends the token, and a failed attempt gets a fresh one', async () => {
    await open('/auth/sign-in');
    await screen.findByRole('group', { name: /robot/ });
    m.signIn.mockResolvedValueOnce({
      error: { code: 'captcha_failed', message: 'captcha protection: request disallowed' },
    });
    fill();
    const submit = screen.getByRole('button', { name: 'Sign in' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    expect(await screen.findByText(/couldn't confirm you're not a robot/)).toBeTruthy();
    expect(m.signIn.mock.calls[0]![0].options).toEqual({ captchaToken: 'token-0' });
    // The first token is spent: the retry must carry the next round's token.
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    m.signIn.mockResolvedValueOnce({ error: { code: 'invalid_credentials', message: 'x' } });
    fireEvent.click(submit);
    await waitFor(() => expect(m.signIn).toHaveBeenCalledTimes(2));
    expect(m.signIn.mock.calls[1]![0].options).toEqual({ captchaToken: 'token-1' });
  });

  it('a failed sign-up or sign-in link also gets a fresh token for the retry', async () => {
    await open('/auth/sign-up');
    await screen.findByRole('group', { name: /robot/ });
    fill();
    const submit = screen.getByRole('button', { name: 'Create account' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    m.signUp.mockResolvedValueOnce({ error: { code: 'captcha_failed', message: 'x' } });
    fireEvent.click(submit);
    await screen.findByText(/couldn't confirm you're not a robot/);
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(m.signUp).toHaveBeenCalledTimes(2));
    expect(m.signUp.mock.calls.map((call) => call[0].options.captchaToken)).toEqual([
      'token-0',
      'token-1',
    ]);
    cleanup();

    await open('/auth/sign-in');
    await screen.findByRole('group', { name: /robot/ });
    fill();
    const link = screen.getByRole('button', { name: 'Email me a sign-in link' });
    await waitFor(() => expect((link as HTMLButtonElement).disabled).toBe(false));
    m.otp.mockResolvedValueOnce({ error: { code: 'captcha_failed', message: 'x' } });
    fireEvent.click(link);
    await screen.findByText(/couldn't confirm you're not a robot/);
    await waitFor(() => expect((link as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(link);
    await waitFor(() => expect(m.otp).toHaveBeenCalledTimes(2));
    expect(m.otp.mock.calls.map((call) => call[0].options.captchaToken)).toEqual([
      'token-0',
      'token-1',
    ]);
  });

  it('emailing a sign-in link sends the token too', async () => {
    await open('/auth/sign-in');
    await screen.findByRole('group', { name: /robot/ });
    fill();
    const link = screen.getByRole('button', { name: 'Email me a sign-in link' });
    await waitFor(() => expect((link as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(link);
    await waitFor(() => expect(m.otp).toHaveBeenCalled());
    expect(m.otp.mock.calls[0]![0].options).toMatchObject({
      shouldCreateUser: false,
      captchaToken: 'token-0',
    });
  });

  it('sign-up sends the token', async () => {
    await open('/auth/sign-up');
    await screen.findByRole('group', { name: /robot/ });
    fill();
    const submit = screen.getByRole('button', { name: 'Create account' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(m.signUp).toHaveBeenCalled());
    expect(m.signUp.mock.calls[0]![0].options).toMatchObject({ captchaToken: 'token-0' });
  });
});

// #576: a blocked Turnstile widget leaves the button off, so the page has to say why.
describe('when the widget cannot produce a token', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    m.broken = true;
  });

  it.each([
    ['/auth/sign-in', 'Sign in'],
    ['/auth/sign-up', 'Create account'],
  ])('%s explains it and offers a reload, with the button still off', async (path, button) => {
    await open(path);
    const message = await screen.findByText(/couldn't run the check that keeps robots out/);
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    fill();
    expect((screen.getByRole('button', { name: button }) as HTMLButtonElement).disabled).toBe(true);
  });
});

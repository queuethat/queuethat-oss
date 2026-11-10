import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneVerify } from './PhoneVerify.tsx';

const m = vi.hoisted(() => ({ request: vi.fn(), rpc: vi.fn(), provider: 'dev' as string | null }));
vi.mock('./captcha/publicJoin.ts', () => ({
  requestPhoneCode: m.request,
  joinProvider: () => m.provider,
}));
vi.mock('./captcha/usePow.ts', () => ({
  usePow: () => ({ token: 'pow-token', progress: 1, failed: false }),
}));
vi.mock('./client.ts', () => ({ guestRpc: m.rpc }));

function show() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PhoneVerify token="tok-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  m.provider = 'dev';
  localStorage.clear();
});
afterEach(cleanup);

describe('PhoneVerify', () => {
  it('requests a code with the captcha token, then confirms the typed code', async () => {
    m.request.mockResolvedValue({ state: 'sent', resend_after: null });
    m.rpc.mockResolvedValue({ state: 'verified', resend_after: null });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /text me a code/i }));
    await waitFor(() => expect(m.request).toHaveBeenCalledWith('tok-1', 'dev'));
    const input = await screen.findByLabelText(/6-digit code/i);
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(screen.getByText(/phone number is confirmed/i)).toBeTruthy());
    expect(m.rpc).toHaveBeenCalledWith('guest_verify_phone_code', {
      p_token: 'tok-1',
      p_code: '123456',
    });
    expect(localStorage.getItem('qm:phone-verified:tok-1')).toBe('1');
  });

  it('says so when the code is wrong and does not mark the phone verified', async () => {
    m.request.mockResolvedValue({ state: 'sent', resend_after: null });
    m.rpc.mockResolvedValue({ state: 'invalid', resend_after: null });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /text me a code/i }));
    fireEvent.change(await screen.findByLabelText(/6-digit code/i), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/didn't work/i));
    expect(localStorage.getItem('qm:phone-verified:tok-1')).toBeNull();
  });

  it('shows the refusal for a limit or a failed security check', async () => {
    m.request.mockRejectedValue(Object.assign(new Error('rate_limited'), { code: 'rate_limited' }));
    show();
    fireEvent.click(await screen.findByRole('button', { name: /text me a code/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/too many tries/i));
  });
});

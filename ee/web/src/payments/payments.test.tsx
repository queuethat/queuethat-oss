// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from '@app/lib/i18n.ts';
import paymentsDesk from '../locales/en/payments-desk.json';
import { PayCodeQr } from './PayCodeQr.tsx';
import { RequestPayment } from './RequestPayment.tsx';

const rpc = vi.fn();
vi.mock('@app/lib/supabase.ts', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));

const wrap = (node: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

beforeAll(() => {
  i18next.addResourceBundle('en', 'payments-desk', paymentsDesk, true, true);
});
afterEach(cleanup);
beforeEach(() => rpc.mockReset().mockResolvedValue({ data: null, error: null }));

describe('desk payments', () => {
  it('4-PAY1: staff ask for an amount; the guest never types one', async () => {
    wrap(<RequestPayment visitId="v1" />);
    await userEvent.type(await screen.findByLabelText(/amount to request/i), '18.50');
    await userEvent.click(screen.getByRole('button', { name: /request payment/i }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'staff_request_payment',
        expect.objectContaining({ p_visit_id: 'v1', p_amount_minor: 1850, p_currency: 'usd' }),
      ),
    );
  });

  it('refuses a bad amount before calling', async () => {
    wrap(<RequestPayment visitId="v1" />);
    await userEvent.type(await screen.findByLabelText(/amount to request/i), '0');
    await userEvent.click(screen.getByRole('button', { name: /request payment/i }));
    expect(await screen.findByText(/enter an amount above zero/i)).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('4-PAY2: shows the pay QR with the code to type', async () => {
    rpc.mockResolvedValue({
      data: { code: 'ABCD2345', expires_at: '2026-10-31T12:10:00Z' },
      error: null,
    });
    wrap(<PayCodeQr visitId="v1" amountMinor={1850} currency="usd" />);
    const show = await screen.findByRole('button', { name: /show pay qr/i });
    expect(rpc).not.toHaveBeenCalled();
    await userEvent.click(show);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('staff_create_pay_code', { p_visit_id: 'v1' }),
    );
    expect(await screen.findByRole('heading', { name: /scan to pay \$18\.50/i })).toBeTruthy();
    expect(await screen.findByText('ABCD-2345')).toBeTruthy();
    expect(await screen.findByTestId('ticket-qr')).toBeTruthy();
  });

  it('4-PAY2: a refused code shows an error and no QR', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'illegal_payment_action' } });
    wrap(<PayCodeQr visitId="v1" amountMinor={1850} currency="usd" />);
    await userEvent.click(await screen.findByRole('button', { name: /show pay qr/i }));
    expect(await screen.findByText(/could not make a code/i)).toBeTruthy();
    expect(screen.queryByTestId('ticket-qr')).toBeNull();
  });
});

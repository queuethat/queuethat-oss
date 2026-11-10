import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { PayCodePage } from './PayCodePage.tsx';

const byCode = vi.fn();
vi.mock('../booking/payment/api.ts', () => ({
  requestPosPaymentByCode: (...a: unknown[]) => byCode(...a),
}));
vi.mock('../booking/payment/stripe.ts', () => ({
  loadStripe: () => Promise.reject(new Error('no')),
}));

const info = {
  paymentId: 'p1',
  kind: 'pos',
  amountMinor: 1850,
  currency: 'usd',
  cancelCutoffHours: 24,
  releaseAfter: 'served',
  clientSecret: 'cs_1',
  publishableKey: '',
};

function setup() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PayCodePage code="ABCD2345" />
    </QueryClientProvider>,
  );
}

beforeAll(() => loadNamespaces('booking'));
afterEach(() => {
  cleanup();
  byCode.mockReset();
});

describe('PayCodePage', () => {
  it('4-PAY2: the scanned code shows the amount staff asked for, then thanks the guest', async () => {
    byCode.mockResolvedValue(info);
    setup();
    expect(await screen.findByRole('heading', { name: 'Pay at the counter' })).toBeTruthy();
    expect(screen.getByText('$18.50')).toBeTruthy();
    expect(byCode).toHaveBeenCalledWith('ABCD2345');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText(/your payment went through/i)).toBeTruthy();
  });

  it('4-PAY2: an unknown, expired or paid code is one message that says to ask staff', async () => {
    byCode.mockResolvedValue(null);
    setup();
    expect(await screen.findByRole('heading', { name: /payment link has ended/i })).toBeTruthy();
    expect(screen.getByText(/ask the staff for a new code/i)).toBeTruthy();
  });

  it('4-PAY2: a failed lookup says so instead of claiming the code ended', async () => {
    byCode.mockRejectedValue(new Error('payment_unavailable'));
    setup();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/could not reach the payment service/i)).toBeTruthy();
  });

  it('4-PAY2: coming back from 3-D Secure thanks the guest without looking the code up', async () => {
    window.history.pushState({}, '', '/pay/ABCD2345?redirect_status=succeeded');
    setup();
    expect(await screen.findByText(/your payment went through/i)).toBeTruthy();
    expect(byCode).not.toHaveBeenCalled();
    window.history.pushState({}, '', '/');
  });
});

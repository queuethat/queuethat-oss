import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { PosPay } from './PosPay.tsx';

const request = vi.fn();
vi.mock('../booking/payment/api.ts', () => ({
  requestPosPayment: (...a: unknown[]) => request(...a),
}));
vi.mock('../booking/payment/stripe.ts', () => ({
  loadStripe: () => Promise.reject(new Error('no')),
}));

const info = (o: Record<string, unknown> = {}) => ({
  paymentId: 'p1',
  kind: 'pos',
  amountMinor: 1850,
  currency: 'usd',
  cancelCutoffHours: 24,
  releaseAfter: 'served',
  clientSecret: 'cs_1',
  publishableKey: '',
  ...o,
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PosPay token="tok-12345678" />
    </QueryClientProvider>,
  );
}

beforeAll(() => loadNamespaces('booking', 'guest-status'));
afterEach(() => {
  cleanup();
  request.mockReset();
});

describe('PosPay', () => {
  it('shows nothing while staff have asked for no payment', async () => {
    request.mockResolvedValue(null);
    setup();
    await waitFor(() => expect(request).toHaveBeenCalledWith('tok-12345678'));
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('4-PAY1: shows the amount staff asked for, then thanks the guest after paying', async () => {
    request.mockResolvedValue(info());
    setup();
    expect(await screen.findByRole('heading', { name: 'Pay at the counter' })).toBeTruthy();
    expect(screen.getByText('$18.50')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText(/your payment went through/i)).toBeTruthy();
  });
});

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import type { PaymentIntentInfo } from './api.ts';
import PaymentStep from './PaymentStep.tsx';

const confirmPayment = vi.fn();
const confirmSetup = vi.fn();
const mount = vi.fn();
vi.mock('./stripe.ts', () => ({
  loadStripe: () =>
    Promise.resolve({
      elements: () => ({ create: () => ({ mount, destroy: () => {} }) }),
      confirmPayment: (...a: unknown[]) => confirmPayment(...a),
      confirmSetup: (...a: unknown[]) => confirmSetup(...a),
    }),
}));

const info = (o: Partial<PaymentIntentInfo> = {}): PaymentIntentInfo => ({
  paymentId: 'p1',
  kind: 'hold',
  amountMinor: 2500,
  currency: 'usd',
  cancelCutoffHours: 24,
  releaseAfter: 'served',
  clientSecret: 'cs_1',
  publishableKey: 'pk_test_1',
  ...o,
});

function setup(i: PaymentIntentInfo, onDone = vi.fn()) {
  render(<PaymentStep info={i} token="tok-12345678" onDone={onDone} />);
  return onDone;
}

beforeAll(() => loadNamespaces('booking'));
afterEach(cleanup);

describe('PaymentStep', () => {
  beforeEach(() => {
    confirmPayment.mockReset().mockResolvedValue({});
    confirmSetup.mockReset().mockResolvedValue({});
    mount.mockReset();
  });

  it('shows the amount, what happens to it and the cancellation policy before any card is entered', async () => {
    setup(info());
    expect(screen.getByRole('heading', { name: 'Secure your booking' })).toBeTruthy();
    expect(screen.getByText(/hold of \$25\.00 on your card/)).toBeTruthy();
    expect(screen.getByText(/Cancel at least 24 hours before/)).toBeTruthy();
    await waitFor(() => expect(mount).toHaveBeenCalled());
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it('offers no way to continue without a card when a processor is connected', async () => {
    setup(info());
    await waitFor(() => expect(mount).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /without paying/i })).toBeNull();
  });

  it('confirms the payment and continues once the card is accepted (AC1)', async () => {
    const onDone = setup(info());
    await userEvent.click(await screen.findByRole('button', { name: /place hold of \$25\.00/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ redirect: 'if_required' }),
    );
  });

  it('waits for the 3-D Secure challenge to finish before continuing (AC2)', async () => {
    let finish: (v: object) => void = () => {};
    confirmPayment.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onDone = setup(info({ kind: 'deposit' }));
    await userEvent.click(await screen.findByRole('button', { name: /pay \$25\.00 deposit/i }));
    expect(onDone).not.toHaveBeenCalled();
    finish({});
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('saves the card with a setup confirmation when the booking is far off', async () => {
    const onDone = setup(info({ kind: 'card_on_file' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save card' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(confirmSetup).toHaveBeenCalled();
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it('reports a declined card, focuses the message and allows another try', async () => {
    confirmPayment.mockResolvedValueOnce({ error: { code: 'card_declined' } });
    const onDone = setup(info());
    await userEvent.click(await screen.findByRole('button', { name: /place hold/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/declined/);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /place hold/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('collects no card when no processor is connected', async () => {
    const onDone = setup(info({ publishableKey: '' }));
    expect(screen.getByRole('note').textContent).toMatch(/nothing is charged/);
    await userEvent.click(screen.getByRole('button', { name: 'Continue to my appointment' }));
    expect(onDone).toHaveBeenCalled();
    expect(confirmPayment).not.toHaveBeenCalled();
  });
});

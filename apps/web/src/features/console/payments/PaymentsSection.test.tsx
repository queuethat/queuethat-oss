import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from '../../../lib/i18n.ts';
import payments from '../../../locales/en/payments.json';
import '../../../lib/i18n.ts';
import { PaymentsSection } from './PaymentsSection.tsx';

let role = 'manager';
vi.mock('../../auth/current.ts', () => ({
  useCurrentOrg: () => ({ role }),
  useCurrentLocation: () => ({ location: null }),
}));
const rpc = vi.fn();
const rows = vi.fn();
vi.mock('../../../lib/supabase.ts', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    schema: () => ({
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        const result = () =>
          table === 'appointments' ? { data: [], error: null } : { data: rows(), error: null };
        for (const m of ['select', 'eq', 'or', 'order']) chain[m] = () => chain;
        chain.then = (resolve: (v: unknown) => void) => resolve(result());
        return chain;
      },
    }),
  },
}));

const payment = (o: Record<string, unknown> = {}) => ({
  id: 'p1',
  kind: 'hold',
  status: 'authorized',
  amount_minor: 2500,
  refunded_minor: 0,
  currency: 'usd',
  ...o,
});

function setup(visitStatus: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PaymentsSection visitId="v1" visitStatus={visitStatus} />
    </QueryClientProvider>,
  );
}

// Added directly, not through the lazy loader, so the test does not depend on the glob import.
beforeAll(() => {
  i18next.addResourceBundle('en', 'payments', payments, true, true);
});
afterEach(cleanup);

describe('PaymentsSection', () => {
  beforeEach(() => {
    role = 'manager';
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    rows.mockReset().mockReturnValue([payment()]);
  });

  it('shows no charge or refund actions to staff', async () => {
    role = 'staff';
    rows.mockReturnValue([payment(), payment({ id: 'p2', kind: 'deposit', status: 'succeeded' })]);
    setup('no_show');
    await waitFor(() => expect(screen.getAllByTestId('visit-payment')).toHaveLength(2));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not charge on the first tap, only after the confirm', async () => {
    setup('no_show');
    await userEvent.click(await screen.findByRole('button', { name: /charge no-show fee/i }));
    expect(rpc).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: /^charge \$25\.00$/i }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'staff_charge_no_show',
        expect.objectContaining({ p_payment_id: 'p1' }),
      ),
    );
  });

  it('offers the charge only for a no-show visit', async () => {
    setup('waiting');
    await waitFor(() => expect(screen.getAllByTestId('visit-payment')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /charge no-show fee/i })).toBeNull();
  });

  it('4-PAY1: staff ask a serving guest to pay an amount, with no card form and no amount from the guest', async () => {
    role = 'staff';
    rows.mockReturnValue([]);
    setup('serving');
    await userEvent.type(await screen.findByLabelText(/amount to request/i), '18.50');
    await userEvent.click(screen.getByRole('button', { name: /request payment/i }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'staff_request_payment',
        expect.objectContaining({ p_visit_id: 'v1', p_amount_minor: 1850, p_currency: 'usd' }),
      ),
    );
  });

  it('refuses a bad amount before calling and offers no request for a waiting guest', async () => {
    rows.mockReturnValue([]);
    const { unmount } = setup('serving');
    await userEvent.type(await screen.findByLabelText(/amount to request/i), '0');
    await userEvent.click(screen.getByRole('button', { name: /request payment/i }));
    expect(await screen.findByText(/enter an amount above zero/i)).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
    unmount();
    setup('waiting');
    await waitFor(() => expect(screen.queryByLabelText(/amount to request/i)).toBeNull());
  });

  it('4-PAY2: an unpaid counter payment shows a pay QR with the code to type, and nothing else does', async () => {
    role = 'staff';
    rpc.mockResolvedValue({
      data: { code: 'ABCD2345', expires_at: '2026-10-31T12:10:00Z' },
      error: null,
    });
    rows.mockReturnValue([
      payment({ id: 'p1', kind: 'pos', status: 'requires_action', amount_minor: 1850 }),
      payment({ id: 'p2', kind: 'pos', status: 'succeeded' }),
    ]);
    setup('serving');
    const buttons = await screen.findAllByRole('button', { name: /show pay qr/i });
    expect(buttons).toHaveLength(1);
    expect(rpc).not.toHaveBeenCalled();
    await userEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('staff_create_pay_code', { p_visit_id: 'v1' }),
    );
    expect(await screen.findByRole('heading', { name: /scan to pay \$18\.50/i })).toBeTruthy();
    expect(await screen.findByText('ABCD-2345')).toBeTruthy();
    expect(await screen.findByTestId('ticket-qr')).toBeTruthy();
  });

  it('4-PAY2: a refused code shows an error and no QR', async () => {
    role = 'staff';
    rpc.mockResolvedValue({ data: null, error: { message: 'illegal_payment_action' } });
    rows.mockReturnValue([payment({ kind: 'pos', status: 'requires_action' })]);
    setup('serving');
    await userEvent.click(await screen.findByRole('button', { name: /show pay qr/i }));
    expect(await screen.findByText(/could not make a code/i)).toBeTruthy();
    expect(screen.queryByTestId('ticket-qr')).toBeNull();
  });
});

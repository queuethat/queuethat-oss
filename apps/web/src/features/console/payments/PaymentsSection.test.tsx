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
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { AppointmentPage } from './AppointmentPage.tsx';

const m = vi.hoisted(() => ({
  status: 'pending_payment',
  provider: null as string | null,
  requestPayment: vi.fn(),
}));

vi.mock('../booking/api.ts', () => ({
  useAppointment: () => ({
    isPending: false,
    isError: false,
    data: {
      status: m.status,
      starts_at: '2030-01-07T15:00:00Z',
      ends_at: '2030-01-07T15:20:00Z',
      service_name: 'Haircut',
      location_name: 'Main St',
      location_slug: 'main-st',
      can_reschedule: false,
      can_cancel: true,
      provider_name: m.provider,
    },
  }),
  useBookingLocation: () => ({ isPending: false, data: { tz: 'UTC', services: [] } }),
  useCancelAppointment: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../booking/payment/api.ts', () => ({ requestPayment: m.requestPayment }));
vi.mock('../booking/payment/PaymentStep.tsx', () => ({
  default: () => <p>card step</p>,
}));
vi.mock('./Reminders.tsx', () => ({ Reminders: () => <p>reminders</p> }));

function show() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AppointmentPage token="apt-12345678" />
    </QueryClientProvider>,
  );
}

beforeAll(() => loadNamespaces('booking'));
beforeEach(() => {
  m.status = 'pending_payment';
  m.provider = null;
  m.requestPayment.mockReset();
});
afterEach(cleanup);

describe('AppointmentPage while the booking waits for its card', () => {
  it('says the time is held, offers the card step and no reminders', () => {
    show();
    expect(screen.getByText('Waiting for your card')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/held for a few minutes/);
    expect(screen.getByRole('button', { name: 'Add card to confirm' })).toBeTruthy();
    expect(screen.queryByText('reminders')).toBeNull();
  });

  it('opens the card step with the payment the database asks for', async () => {
    m.requestPayment.mockResolvedValue({ kind: 'hold', amountMinor: 500, publishableKey: '' });
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Add card to confirm' }));
    expect(await screen.findByText('card step')).toBeTruthy();
    expect(m.requestPayment).toHaveBeenCalledWith('apt-12345678', expect.any(String));
  });

  it('tells the guest when the payment service cannot be reached', async () => {
    m.requestPayment.mockRejectedValue(new Error('payment_unavailable'));
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Add card to confirm' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/payment service/));
  });

  it('shows no card prompt once the booking is confirmed', () => {
    m.status = 'booked';
    show();
    expect(screen.queryByRole('button', { name: 'Add card to confirm' })).toBeNull();
    expect(screen.getByText('reminders')).toBeTruthy();
  });
});

describe('AppointmentPage on a provider line (M7)', () => {
  it('names the provider', () => {
    m.status = 'booked';
    m.provider = 'Dr Ada';
    show();
    expect(screen.getByText('With Dr Ada')).toBeTruthy();
  });

  it('names no one when the database gives no provider', () => {
    m.status = 'booked';
    show();
    expect(screen.queryByText(/^With /)).toBeNull();
  });
});

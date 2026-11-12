import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { BookingPage } from './BookingPage.tsx';

// M7 (#1294): with provider lines every person offers their own "Checkup"; the picker names whose.
const m = vi.hoisted(() => ({
  lines: [] as { queue_id: string; name: string }[],
  live: [] as unknown[],
}));
const slot = [{ slot_start: '2030-01-07T15:00:00Z', slot_end: '2030-01-07T15:30:00Z' }];

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('./events/api.ts', () => ({ useLocationEvents: () => ({ data: [] }) }));
vi.mock('./api.ts', () => ({
  useBookingLocation: () => ({
    isPending: false,
    isError: false,
    data: {
      name: 'Clinic',
      tz: 'UTC',
      countryCode: 'CA',
      retentionDays: 365,
      captchaSiteKey: null,
      services: [
        { id: 's-ada', name: 'Checkup', queueId: 'q-ada' },
        { id: 's-ben', name: 'Checkup', queueId: 'q-ben' },
        { id: 's-walk', name: 'Flu shot', queueId: 'q-walk' },
      ],
    },
  }),
  useServiceSlots: () => ({
    isPending: false,
    isError: false,
    slots: { 's-ada': slot, 's-ben': slot, 's-walk': slot },
    refresh: vi.fn(),
  }),
  useBook: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('../guest/api.ts', () => ({
  useSetBookingAnswers: () => ({ mutate: vi.fn() }),
  useLocationLines: (...args: unknown[]) => {
    m.live.push(args[2]);
    return { data: m.lines };
  },
}));

function show() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <BookingPage slug="clinic" />
    </QueryClientProvider>,
  );
}

beforeAll(() => loadNamespaces('booking'));
afterEach(() => {
  cleanup();
  m.lines = [];
  m.live = [];
});

describe('BookingPage with provider lines', () => {
  it('names the provider line beside each service', () => {
    m.lines = [
      { queue_id: 'q-ada', name: 'Dr Ada' },
      { queue_id: 'q-ben', name: 'Dr Ben' },
      { queue_id: 'q-walk', name: 'Walk-ins' },
    ];
    show();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Checkup · Dr Ada');
    expect(options).toContain('Checkup · Dr Ben');
    expect(options).toContain('Flu shot · Walk-ins');
  });

  it('reads the lines once, without the join page poll', () => {
    show();
    expect(m.live.every((live) => live === false)).toBe(true);
  });

  it('keeps plain service names for a location without provider lines', () => {
    show();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options.filter((o) => o === 'Checkup')).toHaveLength(2);
    expect(options.some((o) => o?.includes('·'))).toBe(false);
  });
});

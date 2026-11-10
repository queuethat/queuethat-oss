import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from '../../../../lib/i18n.ts';
import staff from '../../../../locales/en/staff.json';
import { WaiverRecord } from './WaiverRecord.tsx';

vi.mock('../../../auth/current.ts', () => ({
  useCurrentLocation: () => ({ location: { id: 'l1', tz: 'America/Phoenix' } }),
}));
const rows = vi.fn();
vi.mock('../../../../lib/supabase.ts', () => ({
  supabase: {
    schema: () => ({
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        const result = () =>
          table === 'appointments'
            ? { data: [{ id: 'a1' }], error: null }
            : { data: rows(), error: null };
        for (const m of ['select', 'eq', 'in', 'order']) chain[m] = () => chain;
        chain.then = (resolve: (v: unknown) => void) => resolve(result());
        return chain;
      },
    }),
  },
}));

const setup = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WaiverRecord visitId="v1" />
    </QueryClientProvider>,
  );

beforeAll(() => {
  i18next.addResourceBundle('en', 'staff', staff, true, true);
});
afterEach(cleanup);

describe('WaiverRecord', () => {
  it('shows version, local time and typed name, and the guardian', async () => {
    rows.mockReturnValue([
      {
        id: 'w1',
        accepted_at: '2026-11-09T16:42:00Z',
        field_key: 'terms',
        typed_name: 'Ann Lee',
        guardian_name: 'Bo Lee',
        form_versions: {
          version: 3,
          fields: [{ key: 'terms', label: 'Studio waiver' }],
          forms: { name: 'W' },
        },
      },
    ]);
    setup();
    expect(await screen.findByText('Agreed v3, 2026-11-09 09:42, Ann Lee')).toBeTruthy();
    expect(screen.getByText('Studio waiver')).toBeTruthy();
    expect(screen.getByText('Guardian: Bo Lee')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing when the visit has no agreement', async () => {
    rows.mockReturnValue([]);
    setup();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('visit-waiver')).toBeNull();
  });
});

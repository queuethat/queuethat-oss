import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@qm/ui';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { WaiverRetention } from './WaiverRetention.tsx';

const update = vi.fn();
vi.mock('../../../../lib/supabase.ts', () => ({
  supabase: {
    schema: () => ({
      from: () => {
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'eq']) chain[m] = () => chain;
        chain.single = () => Promise.resolve({ data: { waiver_retention_days: 365 }, error: null });
        chain.update = (v: unknown) => {
          update(v);
          return {
            eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'o1' }], error: null }) }),
          };
        };
        return chain;
      },
    }),
  },
}));

beforeAll(() => loadNamespaces('admin-forms', 'common'));
afterEach(cleanup);

const setup = (canEdit: boolean) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
        <WaiverRetention orgId="o1" canEdit={canEdit} />
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('WaiverRetention', () => {
  it('shows 365 and saves a longer period up to seven years', async () => {
    setup(true);
    const input = await screen.findByLabelText(/days to keep waiver records/i);
    expect((input as HTMLInputElement).value).toBe('365');
    await userEvent.clear(input);
    await userEvent.type(input, '2556');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(input);
    await userEvent.type(input, '2555');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ waiver_retention_days: 2555 }));
  });

  it('is read-only for a manager', async () => {
    setup(false);
    expect(await screen.findByText(/only admins and owners/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

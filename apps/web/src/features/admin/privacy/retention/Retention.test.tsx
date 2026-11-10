import { ToastProvider } from '@qm/ui';
import { QueryClient, QueryClientProvider, queryOptions } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { Retention } from './Retention.tsx';

const m = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('../api.ts', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    RETENTION_MIN: 1,
    RETENTION_MAX: 365,
    retentionQuery: () => queryOptions({ queryKey: ['ret'], queryFn: () => Promise.resolve(30) }),
    useSetRetention: () => useMutation({ mutationFn: (days: number) => m.save(days) }),
  };
});

beforeAll(() => loadNamespaces('admin-privacy'));
afterEach(() => {
  cleanup();
  m.save.mockReset();
});

function setup(canEdit = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
        <Retention orgId="org-a" canEdit={canEdit} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Retention', () => {
  it('explains the chosen period and keeps the 365-day maximum', async () => {
    setup();
    const field = await screen.findByLabelText(/Keep contact details/);
    expect(field.getAttribute('max')).toBe('365');
    expect(screen.getByTestId('retention-impact').textContent).toContain('After 30 days');
    await userEvent.clear(field);
    await userEvent.type(field, '1');
    expect(screen.getByTestId('retention-impact').textContent).toContain('After 1 day,');
    expect(screen.getByText(/coming with forms/)).toBeTruthy();
  });

  it('warns when shortening and refuses values above the cap', async () => {
    setup();
    const field = await screen.findByLabelText(/Keep contact details/);
    expect(screen.queryByTestId('retention-shorter')).toBeNull();
    await userEvent.clear(field);
    await userEvent.type(field, '7');
    expect(screen.getByTestId('retention-shorter')).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.type(field, '366');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('retention-impact')).toBeNull();
  });

  it('saves the number and says when the platform cap refuses it', async () => {
    m.save.mockRejectedValueOnce(new Error('retention_over_cap'));
    setup();
    const field = await screen.findByLabelText(/Keep contact details/);
    await userEvent.clear(field);
    await userEvent.type(field, '90');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.save).toHaveBeenCalledWith(90));
    expect(await screen.findByText(/allows at most 365 days/)).toBeTruthy();
  });

  it('is read-only without edit rights', async () => {
    setup(false);
    expect((await screen.findByLabelText(/Keep contact details/)).hasAttribute('readonly')).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

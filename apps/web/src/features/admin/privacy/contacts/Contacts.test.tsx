import { ToastProvider } from '@qm/ui';
import { QueryClient, QueryClientProvider, queryOptions } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import type { PrivacyContact } from './api.ts';
import { Contacts } from './Contacts.tsx';

const m = vi.hoisted(() => ({ save: vi.fn(), saved: null as PrivacyContact | null }));

vi.mock('./api.ts', async (orig) => {
  const { useMutation } = await import('@tanstack/react-query');
  const real = await orig<typeof import('./api.ts')>();
  return {
    ...real,
    privacyContactQuery: () =>
      queryOptions({ queryKey: ['pc'], queryFn: () => Promise.resolve(m.saved) }),
    useSavePrivacyContact: () => useMutation({ mutationFn: (c: PrivacyContact) => m.save(c) }),
  };
});

beforeAll(() => loadNamespaces('admin-privacy'));
afterEach(() => {
  cleanup();
  m.save.mockReset();
  m.saved = null;
});

function setup(canEdit = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
        <Contacts orgId="org-a" canEdit={canEdit} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Contacts', () => {
  it('says none is recorded, labels the links as information and saves a new officer', async () => {
    m.save.mockResolvedValue(undefined);
    setup();
    expect(await screen.findByTestId('contacts-missing')).toBeTruthy();
    expect(screen.getByText(/Information, not advice/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /Office of the Privacy Commissioner of Canada/ }),
    ).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save privacy officer' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Name'), 'Dana');
    await userEvent.type(screen.getByLabelText('Email'), 'dana@example.test');
    await userEvent.click(save);
    await waitFor(() => expect(m.save).toHaveBeenCalledOnce());
    expect(m.save.mock.calls[0]?.[0]).toMatchObject({
      officerName: 'Dana',
      email: 'dana@example.test',
      jurisdiction: 'ca',
      showPhone: false,
    });
  });

  it('switches the reporting links with the jurisdiction', async () => {
    m.saved = {
      officerName: 'Dana',
      email: 'd@e.test',
      phone: '',
      jurisdiction: 'ca',
      showPhone: false,
    };
    setup();
    await screen.findByDisplayValue('Dana');
    await userEvent.selectOptions(screen.getByLabelText('Where your business is regulated'), 'uk');
    expect(screen.getByRole('link', { name: /UK ICO/ })).toBeTruthy();
  });

  it('is read-only for a manager', async () => {
    m.saved = {
      officerName: 'Dana',
      email: 'd@e.test',
      phone: '',
      jurisdiction: 'ca',
      showPhone: false,
    };
    setup(false);
    await screen.findByDisplayValue('Dana');
    expect(screen.queryByRole('button', { name: 'Save privacy officer' })).toBeNull();
  });
});

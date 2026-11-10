import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { IncidentsPage } from './IncidentsPage.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../../../lib/supabase.ts', () => {
  const result = Promise.resolve({ data: [], error: null });
  const chain: Record<string, unknown> = { then: result.then.bind(result) };
  for (const method of ['select', 'order', 'eq']) chain[method] = () => chain;
  return { supabase: { rpc: m.rpc, schema: () => ({ from: () => chain }) } };
});

const ORG = '9f2c0a10-1111-4222-8333-444455556666';
const incident = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  kind: 'data_exposure',
  title: 'Log leak',
  status: 'suspected',
  detected_at: '2026-11-09T00:00:00Z',
  org_ids: [ORG],
  data_categories: ['contact'],
  record_count: 12,
  notify_due_at: '2026-11-12T00:00:00Z',
  notify_state: 'pending',
  escalated: false,
  retain_until: '2031-11-09T00:00:00Z',
  ...over,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IncidentsPage />
    </QueryClientProvider>,
  );
}

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => m.rpc.mockReset());
afterEach(cleanup);

describe('IncidentsPage', () => {
  it('shows the escalation flag the database computed, not one it works out itself', async () => {
    m.rpc.mockResolvedValue({
      data: [
        incident({ title: 'Late one', notify_state: 'overdue', escalated: true }),
        incident({ title: 'Done one', notify_state: 'done' }),
      ],
      error: null,
    });
    renderPage();
    expect(await screen.findByText('Late one')).toBeTruthy();
    expect(screen.getByText('Notice overdue')).toBeTruthy();
    expect(screen.getByText('Tenants notified')).toBeTruthy();
  });

  it('says only operators can open it when the database refuses', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission_denied' } });
    renderPage();
    expect(await screen.findByText('Only platform operators can open the register.')).toBeTruthy();
  });

  it('files an incident with the business ids pulled out of pasted text', async () => {
    m.rpc.mockImplementation((name: string) =>
      Promise.resolve({ data: name === 'platform_list_incidents' ? [] : null, error: null }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Title'), 'Misdirected email');
    await user.type(screen.getByLabelText(/Affected business ids/), `${ORG.toUpperCase()}, ${ORG}`);
    await user.click(screen.getByLabelText('Contact details'));
    await user.click(screen.getByRole('button', { name: 'File incident' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith(
        'platform_create_incident',
        expect.objectContaining({
          p_title: 'Misdirected email',
          p_org_ids: [ORG],
          p_data_categories: ['contact'],
        }),
      ),
    );
  });
});

describe('IncidentDetail', () => {
  it('lists owners and the breach contact, and stops the clock only after a confirm', async () => {
    m.rpc.mockImplementation((name: string) => {
      if (name === 'platform_list_incidents') {
        return Promise.resolve({ data: [incident({ id: 'i1', title: 'Log leak' })], error: null });
      }
      if (name === 'platform_incident_tenants') {
        return Promise.resolve({
          data: [
            {
              org_id: ORG,
              org_name: 'Acme Barber',
              owners: [{ user_id: 'u1', email: 'boss@acme.test' }],
              breach_contact: null,
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/boss@acme.test/)).toBeTruthy();
    expect(screen.getByText(/no breach contact set/)).toBeTruthy();
    expect(screen.getByText('No break-glass openings on these businesses.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Mark tenants notified' }));
    expect(m.rpc).not.toHaveBeenCalledWith(
      'platform_update_incident',
      expect.objectContaining({ p_mark_notified: true }),
    );
    await user.click(screen.getByRole('button', { name: 'Mark notified' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith(
        'platform_update_incident',
        expect.objectContaining({ p_id: 'i1', p_mark_notified: true }),
      ),
    );
  });
});

import { ToastProvider } from '@qm/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { logToCsv, type LogEntry } from './api.ts';
import { IncidentLog } from './IncidentLog.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn(), rows: [] as unknown[] }));

vi.mock('../../../../lib/supabase.ts', () => {
  const chain: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: m.rows, error: null }).then(ok),
  };
  for (const method of ['select', 'order', 'eq', 'limit', 'is']) chain[method] = () => chain;
  return { supabase: { rpc: m.rpc, schema: () => ({ from: () => chain }) } };
});

const entry = (over: Partial<LogEntry>): LogEntry => ({
  id: crypto.randomUUID(),
  kind: 'data_exposure',
  title: 'Tablet left unlocked',
  description: null,
  data_categories: ['contact'],
  detected_at: '2026-11-09T00:00:00Z',
  people_affected: null,
  actions_taken: null,
  regulator_notified: null,
  ...over,
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss" undoLabel="Undo">
        <IncidentLog orgId="org-a" canEdit />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeAll(() => loadNamespaces('admin-privacy'));
beforeEach(() => {
  m.rpc.mockReset();
  m.rpc.mockResolvedValue({ data: null, error: null });
});
afterEach(() => {
  cleanup();
  m.rows = [];
});

describe('IncidentLog', () => {
  it('lists an entry with its own description, with no notice to confirm', async () => {
    m.rows = [entry({ description: 'A tablet was left unlocked.' })];
    setup();
    expect(await screen.findByRole('heading', { name: 'Tablet left unlocked' })).toBeTruthy();
    const [first] = screen.getAllByLabelText('What happened');
    expect((first as HTMLTextAreaElement).value).toBe('A tablet was left unlocked.');
    expect(screen.queryByRole('button', { name: /read this notice/ })).toBeNull();
  });

  it('adds a suspected incident to the log of this business and says it is not a regulator report', async () => {
    setup();
    expect(await screen.findByTestId('incidents-none')).toBeTruthy();
    expect(screen.getByText(/does not notify a regulator/)).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Report incident' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Short title'), 'Phone lost');
    await userEvent.click(submit);
    await waitFor(() => expect(m.rpc).toHaveBeenCalledOnce());
    expect(m.rpc.mock.calls[0]).toMatchObject([
      'report_incident',
      {
        p_org_id: 'org-a',
        p_kind: 'unauthorized_access',
        p_title: 'Phone lost',
        p_notify_platform: false,
      },
    ]);
  });

  it('exports every row and neutralises spreadsheet formulas', () => {
    const csv = logToCsv(
      ['a', 'b'],
      [entry({ title: '=HYPERLINK("x")', description: 'line, one' })],
    );
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[1]).toContain('"line, one"');
  });
});

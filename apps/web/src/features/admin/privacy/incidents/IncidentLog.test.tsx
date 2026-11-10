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
  org_id: 'org-a',
  source: 'platform_notice',
  incident_id: null,
  notice_id: null,
  kind: 'data_exposure',
  title: 'Please read: log leak',
  description: null,
  data_categories: ['contact'],
  detected_at: '2026-11-09T00:00:00Z',
  people_affected: null,
  actions_taken: null,
  regulator_notified: null,
  notice_subject: 'Please read: log leak',
  notice_body: 'Tokens were written to a log.',
  notice_sent_at: '2026-11-09T01:00:00Z',
  acknowledged_at: null,
  acknowledged_by: null,
  created_by: null,
  created_at: '2026-11-09T01:00:00Z',
  updated_at: '2026-11-09T01:00:00Z',
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
  it('shows the platform notice text and acknowledges it through the RPC', async () => {
    const e = entry({});
    m.rows = [e];
    setup();
    expect(await screen.findByTestId('notice-text')).toHaveProperty(
      'textContent',
      'Tokens were written to a log.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'I have read this notice' }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('acknowledge_incident_notice', { p_id: e.id }),
    );
  });

  it('reports a suspected incident for this business and says it is not a regulator report', async () => {
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
        p_notify_platform: true,
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

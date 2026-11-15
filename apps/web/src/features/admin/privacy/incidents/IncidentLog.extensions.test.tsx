import { Checkbox, ToastProvider } from '@qm/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import type { ExtensionSlotProps, WebExtensions } from '../../../../extensions/types.ts';
import { IncidentLog } from './IncidentLog.tsx';
import { entry } from './testEntry.ts';

// A deployment that sends reports on and confirms its own notices, through the two slots.
const m = vi.hoisted(() => ({ rpc: vi.fn(), rows: [] as unknown[] }));

vi.mock('../../../../extensions/installed.ts', () => {
  const extensions: WebExtensions = {
    adminPages: [],
    banners: [],
    slots: {
      'incidents.report': async () => ({
        default: ({ notify, setNotify }: ExtensionSlotProps['incidents.report']) => (
          <Checkbox
            label="Tell the service"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
          />
        ),
      }),
      'incidents.entry': async () => ({
        default: ({ entry, canEdit }: ExtensionSlotProps['incidents.entry']) => (
          <p data-testid="entry-slot">
            {entry.source}:{String(canEdit)}
          </p>
        ),
      }),
    },
  };
  return { extensions };
});
vi.mock('../../../../lib/supabase.ts', () => {
  const chain: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: m.rows, error: null }).then(ok),
  };
  for (const method of ['select', 'order', 'eq', 'limit', 'is']) chain[method] = () => chain;
  return { supabase: { rpc: m.rpc, schema: () => ({ from: () => chain }) } };
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
afterEach(() => {
  cleanup();
  m.rows = [];
  m.rpc.mockReset();
});

describe('IncidentLog with a deployment installed', () => {
  it('gives each entry to the entry slot', async () => {
    m.rows = [entry({ source: 'platform_notice', notice_body: 'Notice' })];
    setup();
    expect((await screen.findByTestId('entry-slot')).textContent).toBe('platform_notice:true');
  });

  it('starts with notify on and sends what the slot chose', async () => {
    m.rpc.mockResolvedValue({ data: null, error: null });
    setup();
    const box = (await screen.findByLabelText('Tell the service')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.type(screen.getByLabelText('Short title'), 'Phone lost');
    await userEvent.click(screen.getByRole('button', { name: 'Report incident' }));
    await waitFor(() => expect(m.rpc).toHaveBeenCalledOnce());
    expect(m.rpc.mock.calls[0]?.[1]).toMatchObject({ p_notify_platform: true });
    expect(await screen.findByText('Reported and added to your log.')).toBeTruthy();

    await userEvent.click(box);
    await userEvent.type(screen.getByLabelText('Short title'), 'Second');
    await userEvent.click(screen.getByRole('button', { name: 'Report incident' }));
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(2));
    expect(m.rpc.mock.calls[1]?.[1]).toMatchObject({ p_notify_platform: false });
  });
});

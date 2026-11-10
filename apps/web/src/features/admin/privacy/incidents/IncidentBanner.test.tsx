import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { IncidentBanner } from './IncidentBanner.tsx';

const m = vi.hoisted(() => ({ role: 'owner', rows: [] as unknown[] }));

vi.mock('../../../auth/current.ts', () => ({
  useCurrentOrg: () => ({ id: 'org-a', role: m.role }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock('../../../../lib/supabase.ts', () => {
  const chain: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: m.rows, error: null }).then(ok),
  };
  for (const method of ['select', 'order', 'eq', 'is']) chain[method] = () => chain;
  return { supabase: { schema: () => ({ from: () => chain }) } };
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <IncidentBanner />
    </QueryClientProvider>,
  );
}

beforeAll(() => loadNamespaces('admin-privacy'));
afterEach(() => {
  cleanup();
  m.rows = [];
  m.role = 'owner';
});

describe('IncidentBanner', () => {
  it('appears for an owner with an unacknowledged notice', async () => {
    m.rows = [{ id: 'l1', notice_subject: 'x' }];
    setup();
    expect(await screen.findByTestId('incident-banner')).toBeTruthy();
    expect(
      screen.getByText('QueueThat sent you a security notice. Please read it and confirm.'),
    ).toBeTruthy();
  });

  it('is absent when every notice was acknowledged, and for staff', async () => {
    setup();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('incident-banner')).toBeNull();
    cleanup();
    m.rows = [{ id: 'l1', notice_subject: 'x' }];
    m.role = 'staff';
    setup();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('incident-banner')).toBeNull();
  });
});

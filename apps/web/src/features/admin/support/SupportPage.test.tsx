import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { SupportPage } from './SupportPage.tsx';

vi.mock('../../auth/current.ts', () => ({
  useCurrentOrg: () => ({ id: 'org-a', role: 'staff' }),
  useCurrentLocation: () => ({ location: { tz: 'UTC' } }),
}));
vi.mock('../../../lib/supabase.ts', () => {
  const chain: Record<string, unknown> = {
    then: (f: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(f),
  };
  for (const k of ['select', 'eq', 'order', 'limit']) chain[k] = () => chain;
  return { supabase: { schema: () => ({ from: () => chain }) } };
});

beforeAll(() => loadNamespaces('admin', 'admin-support'));
afterEach(cleanup);

describe('SupportPage', () => {
  it('shows the help articles beside the access controls, and passes axe', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <SupportPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Help articles' })).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(7);
    expect(screen.getByRole('heading', { name: 'Support access' })).toBeTruthy();
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { LineOwner } from './LineOwner.tsx';

// #1388: a provider line names its person; "Anyone" clears it without changing the kind.
const m = vi.hoisted(() => ({
  kind: 'general',
  provider: null as string | null,
  updates: [] as unknown[],
}));

function builder() {
  const state: { patch?: unknown } = {};
  const chain: Record<string, unknown> = {};
  for (const fn of ['select', 'eq', 'is']) chain[fn] = () => chain;
  chain.update = (patch: unknown) => {
    state.patch = patch;
    return chain;
  };
  chain.then = (resolve: (v: unknown) => unknown) =>
    resolve(
      state.patch !== undefined
        ? (m.updates.push(state.patch), { data: [{ id: 'q1' }], error: null })
        : { data: [{ id: 'q1', kind: m.kind, provider_user_id: m.provider }], error: null },
    );
  return chain;
}

vi.mock('../../../../lib/supabase.ts', () => ({
  supabase: { schema: () => ({ from: () => builder() }) },
}));
vi.mock('../../team/api.ts', () => ({
  membersQuery: () => ({
    queryKey: ['members'],
    queryFn: async () => [
      { id: 'm1', userId: 'ada', displayName: 'Ada', email: null, locationIds: null },
      { id: 'm2', userId: 'far', displayName: 'Far', email: null, locationIds: ['elsewhere'] },
    ],
  }),
}));

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LineOwner orgId="org" locationId="loc" queueId="q1" />
    </QueryClientProvider>,
  );
}

beforeAll(() => loadNamespaces('admin'));
beforeEach(() => {
  m.kind = 'general';
  m.provider = null;
  m.updates = [];
});
afterEach(cleanup);

describe('LineOwner', () => {
  it('offers the people who work here, and naming one makes it their provider line', async () => {
    show();
    const select = await screen.findByLabelText('Whose line is this?');
    const options = [...(select as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(['Anyone', 'Ada']);
    fireEvent.change(select, { target: { value: 'ada' } });
    await waitFor(() => expect(m.updates).toEqual([{ kind: 'provider', provider_user_id: 'ada' }]));
  });

  it('"Anyone" clears the person and keeps the line a provider line', async () => {
    m.kind = 'provider';
    m.provider = 'ada';
    show();
    const select = await screen.findByLabelText('Whose line is this?');
    expect((select as HTMLSelectElement).value).toBe('ada');
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(m.updates).toEqual([{ provider_user_id: null }]));
  });

  it('shows nothing on an "Anyone available" pool', async () => {
    m.kind = 'pool';
    show();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByLabelText('Whose line is this?')).toBeNull();
  });
});

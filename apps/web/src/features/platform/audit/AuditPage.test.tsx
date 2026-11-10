import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { AuditPage } from './AuditPage.tsx';
import type { AuditRow } from './api.ts';

const m = vi.hoisted(() => ({ rpc: vi.fn(), navigate: vi.fn() }));

// Links become anchors whose href carries the search, so a test can read where they go.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => m.navigate,
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string | undefined>;
    children: ReactNode;
  }) => {
    const query = new URLSearchParams(
      Object.entries(search ?? {}).filter((entry): entry is [string, string] => !!entry[1]),
    ).toString();
    return (
      <a
        href={`${to.replace('$orgId', params?.orgId ?? '').replace('/$', `/${params?._splat ?? ''}`)}${query ? `?${query}` : ''}`}
      >
        {children}
      </a>
    );
  },
}));
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

const ACTOR = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const downloads: string[] = [];

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => {
  m.rpc.mockReset();
  m.navigate.mockReset();
  downloads.length = 0;
  URL.createObjectURL = vi.fn(() => 'blob:audit');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row = (id: number, patch: Partial<AuditRow> = {}): AuditRow => ({
  id,
  at: '2026-10-02T12:00:00Z',
  actor_id: ACTOR,
  actor_email: 'op@queuethat.test',
  action: 'org.suspend',
  org_id: ORG,
  org_name: 'Barber Co',
  reason: 'Abuse report',
  support_grant_id: null,
  break_glass_reason: null,
  target: {},
  ...patch,
});
const rowsDescending = (count: number, top = 1000) =>
  Array.from({ length: count }, (_, i) => row(top - i));

function show(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
const page = (filter = {}, canSeeAll = true) =>
  show(<AuditPage filter={filter} canSeeAll={canSeeAll} />);
const searchCall = () => m.rpc.mock.calls.find(([name]) => name === 'platform_audit_search')?.[1];

describe('rows', () => {
  it('shows who did what to which business, with links to filter by actor and open the org', async () => {
    m.rpc.mockResolvedValue({
      data: [row(7, { target: { from: 'active', to: 'suspended' } })],
      error: null,
    });
    page({ from: '2026-10-01' });
    const rows = await screen.findAllByTestId('audit-row');
    expect(rows).toHaveLength(1);
    const cells = within(rows[0]!);
    expect(cells.getByRole('link', { name: 'op@queuethat.test' })).toHaveProperty(
      'href',
      expect.stringContaining(`/platform/audit?from=2026-10-01&actor=${ACTOR}`),
    );
    expect(cells.getByRole('link', { name: 'Barber Co' }).getAttribute('href')).toBe(
      `/platform/orgs/${ORG}`,
    );
    expect(cells.getByText('org.suspend')).toBeTruthy();
    expect(cells.getByText('Abuse report')).toBeTruthy();
    expect(cells.getByText(/"suspended"/)).toBeTruthy();
  });

  it('shows the support grant id and the break-glass reason', async () => {
    m.rpc.mockResolvedValue({
      data: [
        row(8, {
          action: 'support.break_glass',
          support_grant_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
          break_glass_reason: 'Customer locked out',
        }),
      ],
      error: null,
    });
    page();
    const cells = within(await screen.findByTestId('audit-row'));
    expect(cells.getByText('99999999')).toBeTruthy();
    expect(cells.getByText('Break-glass')).toBeTruthy();
    expect(cells.getByText('Customer locked out')).toBeTruthy();
  });

  it('names a service-role action, a deleted account and a deleted business without crashing', async () => {
    m.rpc.mockResolvedValue({
      data: [
        row(9, { actor_id: null, actor_email: null, org_id: null, org_name: null, reason: null }),
        row(8, { actor_email: null, org_name: null }),
      ],
      error: null,
    });
    page();
    const rows = await screen.findAllByTestId('audit-row');
    expect(within(rows[0]!).getByText('System')).toBeTruthy();
    expect(within(rows[0]!).getByText('—')).toBeTruthy();
    expect(within(rows[1]!).getByText('Deleted account (11111111)')).toBeTruthy();
    expect(within(rows[1]!).getByText('Deleted business (22222222)')).toBeTruthy();
  });

  it('shows no details toggle for an empty payload', async () => {
    m.rpc.mockResolvedValue({ data: [row(1)], error: null });
    page();
    await screen.findByTestId('audit-row');
    expect(screen.queryByText('Show')).toBeNull();
  });
});

describe('empty, loading and failure', () => {
  it('says so when nothing matches', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    page({ action: 'org.nope' });
    expect(await screen.findByText('No audit entries match.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Next/ })).toBeNull();
  });

  it('says "no more entries" on a page past the end', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    page({ after: '5', before: '9' });
    expect(await screen.findByText('No more entries.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the first page' })).toBeTruthy();
  });

  it('shows a load failure', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'permission_denied', code: '42501' } });
    page();
    expect(await screen.findByText(/Couldn't load this/)).toBeTruthy();
  });
});

describe('pagination boundaries', () => {
  it('asks for one more than a page and shows no next link when the page is exactly full', async () => {
    m.rpc.mockResolvedValue({ data: rowsDescending(50), error: null });
    page();
    expect(await screen.findAllByTestId('audit-row')).toHaveLength(50);
    expect(searchCall().p_limit).toBe(51);
    expect(screen.queryByRole('link', { name: /Next/ })).toBeNull();
  });

  it('with a 51st row, shows 50 and a next link from the 50th row', async () => {
    m.rpc.mockResolvedValue({ data: rowsDescending(51), error: null });
    page();
    expect(await screen.findAllByTestId('audit-row')).toHaveLength(50);
    expect(screen.getByRole('link', { name: 'Next 50' }).getAttribute('href')).toBe(
      '/platform/audit?after=951',
    );
  });

  it('a short page has no next link; the second page links back and forward', async () => {
    m.rpc.mockResolvedValue({ data: rowsDescending(51, 500), error: null });
    page({ after: '951' });
    await screen.findAllByTestId('audit-row');
    expect(searchCall().p_after).toBe(951);
    expect(screen.getByRole('link', { name: 'Previous page' }).getAttribute('href')).toBe(
      '/platform/audit',
    );
    expect(screen.getByRole('link', { name: 'Next 50' }).getAttribute('href')).toBe(
      '/platform/audit?after=451&before=951',
    );
  });

  it('a single row is one page', async () => {
    m.rpc.mockResolvedValue({ data: [row(1)], error: null });
    page();
    expect(await screen.findAllByTestId('audit-row')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: /Next/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Previous page' })).toBeNull();
  });
});

describe('filters', () => {
  it('sends the filters, with local days converted to instants', async () => {
    const was = process.env.TZ;
    process.env.TZ = 'UTC';
    m.rpc.mockResolvedValue({ data: [], error: null });
    page({ actor: ACTOR, org: ORG, action: 'support.', from: '2026-10-01', to: '2026-10-31' });
    await screen.findByText('No audit entries match.');
    expect(searchCall()).toEqual({
      p_actor: ACTOR,
      p_org_id: ORG,
      p_action: 'support.',
      p_from: '2026-10-01T00:00:00.000Z',
      p_to: '2026-11-01T00:00:00.000Z',
      p_limit: 51,
    });
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  });

  it('sends nothing for an empty filter', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    page();
    await screen.findByText('No audit entries match.');
    expect(searchCall()).toEqual({ p_limit: 51 });
  });

  it('support see the own-rows intro and no actor filter', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    page({}, false);
    await screen.findByText('No audit entries match.');
    expect(screen.getByText(/Your own actions/)).toBeTruthy();
    expect(screen.queryByLabelText('Actor ID')).toBeNull();
    expect(screen.getByLabelText('Business ID')).toBeTruthy();
  });

  it('operators get the actor filter', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    page();
    await screen.findByText('No audit entries match.');
    expect(screen.getByLabelText('Actor ID')).toBeTruthy();
  });

  it('submitting navigates with cleaned filters and no cursor', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    const user = userEvent.setup();
    page({ after: '5', before: '9' });
    await screen.findByText('No more entries.');
    await user.type(screen.getByLabelText('Actor ID'), ` ${ACTOR.toUpperCase()} `);
    await user.type(screen.getByLabelText('Action'), 'org.suspend');
    fireEvent.change(screen.getByLabelText('From (local day)'), {
      target: { value: '2026-10-01' },
    });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(m.navigate).toHaveBeenCalledWith({
      to: '/platform/$',
      params: { _splat: 'audit' },
      search: { actor: ACTOR, action: 'org.suspend', from: '2026-10-01' },
    });
  });

  it('refuses a bad id, a bad action and an inverted range, and does not navigate', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    const user = userEvent.setup();
    page();
    await screen.findByText('No audit entries match.');
    await user.type(screen.getByLabelText('Actor ID'), 'agent x');
    await user.type(screen.getByLabelText('Business ID'), '123');
    await user.type(screen.getByLabelText('Action'), 'Drop Table');
    fireEvent.change(screen.getByLabelText('From (local day)'), {
      target: { value: '2026-10-05' },
    });
    fireEvent.change(screen.getByLabelText('To (local day)'), { target: { value: '2026-10-01' } });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getAllByText(/Enter a full ID/)).toHaveLength(2);
    expect(screen.getByText(/lowercase words joined by dots/)).toBeTruthy();
    expect(screen.getByText('The first day must not be after the last day.')).toBeTruthy();
    expect(m.navigate).not.toHaveBeenCalled();
  });

  it('a hand-edited inverted range in the address shows the error and asks the database nothing', async () => {
    page({ from: '2026-10-05', to: '2026-10-01' });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The first day must not be after the last day.',
    );
    expect(m.rpc).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Export CSV' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('export', () => {
  const exportCall = () => m.rpc.mock.calls.filter(([name]) => name === 'platform_audit_export');
  const answer = (exported: unknown) =>
    m.rpc.mockImplementation(async (name: string) =>
      name === 'platform_audit_search'
        ? { data: [], error: null }
        : { data: exported, error: null },
    );

  it('exports the filtered range, not the page, and downloads the file', async () => {
    answer({ csv: 'id\r\n1', row_count: 1, truncated: false, next_after: null });
    const user = userEvent.setup();
    page({ org: ORG, from: '2026-10-01', to: '2026-10-31', after: '40', before: '90' });
    await screen.findByText('No more entries.');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Exported 1 entry.')).toBeTruthy();
    const [, args] = exportCall()[0]!;
    expect(args).toMatchObject({ p_org_id: ORG });
    expect(args).not.toHaveProperty('p_after');
    expect(args).not.toHaveProperty('p_limit');
    expect(downloads).toEqual(['platform-audit-2026-10-01-2026-10-31.csv']);
    expect(screen.queryByText('Download the next part')).toBeNull();
  });

  it('an empty range downloads nothing and says so', async () => {
    answer({ csv: 'id', row_count: 0, truncated: false, next_after: null });
    const user = userEvent.setup();
    page();
    await screen.findByText('No audit entries match.');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(/no file was downloaded/)).toBeTruthy();
    expect(downloads).toEqual([]);
  });

  it('a large export downloads part one, then continues from next_after', async () => {
    m.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
      name === 'platform_audit_search'
        ? { data: [], error: null }
        : args.p_after === undefined
          ? { data: { csv: 'p1', row_count: 10000, truncated: true, next_after: 123 }, error: null }
          : { data: { csv: 'p2', row_count: 7, truncated: false, next_after: null }, error: null },
    );
    const user = userEvent.setup();
    page();
    await screen.findByText('No audit entries match.');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Exported 10,000 entries.')).toBeTruthy();
    expect(screen.getByText(/holds at most 10,000 entries/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Download the next part' }));
    expect(await screen.findByText('Exported 7 entries.')).toBeTruthy();
    expect(exportCall()[1]![1]).toMatchObject({ p_after: 123 });
    expect(downloads).toEqual([
      'platform-audit-start-now.csv',
      'platform-audit-start-now-part2.csv',
    ]);
    expect(screen.queryByRole('button', { name: 'Download the next part' })).toBeNull();
  });

  it('shows a refused export', async () => {
    m.rpc.mockImplementation(async (name: string) =>
      name === 'platform_audit_search'
        ? { data: [], error: null }
        : { data: null, error: { message: 'permission_denied', code: '42501' } },
    );
    const user = userEvent.setup();
    page();
    await screen.findByText('No audit entries match.');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("can't export"));
    expect(downloads).toEqual([]);
  });

  it('an unexpected failure is worded generally', async () => {
    m.rpc.mockImplementation(async (name: string) =>
      name === 'platform_audit_search'
        ? { data: [], error: null }
        : { data: null, error: { message: 'boom' } },
    );
    const user = userEvent.setup();
    page();
    await screen.findByText('No audit entries match.');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('The export failed. Try again.')).toBeTruthy();
  });
});

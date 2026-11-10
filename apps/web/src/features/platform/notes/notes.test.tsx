import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { parseTags, type OrgNote, type TaggedOrg } from './api.ts';
import { NotesSection } from './NotesSection.tsx';
import { TaggedTenants } from './TaggedTenants.tsx';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => <a href={to.replace('$orgId', params?.orgId ?? '')}>{children}</a>,
}));
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));

beforeAll(() => loadNamespaces('platform'));
beforeEach(() => m.rpc.mockReset());
afterEach(cleanup);

function show(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const note = (over: Partial<OrgNote> = {}): OrgNote => ({
  id: 'n1',
  version_id: 'n1',
  org_id: 'org-1',
  author_email: 'agent@queuethat.test',
  body: 'Promised a credit',
  tags: ['billing-issue'],
  version: 1,
  created_at: '2026-11-01T10:00:00Z',
  first_created_at: '2026-11-01T10:00:00Z',
  ...over,
});

/** Answers list calls with `notes` and every other call with `reply`. */
function answer(notes: OrgNote[], reply: { data?: unknown; error?: { message: string } } = {}) {
  m.rpc.mockImplementation((name: string) =>
    Promise.resolve(
      name === 'platform_list_notes'
        ? { data: notes, error: null }
        : { data: reply.data ?? null, error: reply.error ?? null },
    ),
  );
}
const addCalls = () => m.rpc.mock.calls.filter(([name]) => name === 'platform_add_note');

describe('parseTags', () => {
  it('splits on commas and spaces and drops blanks, leaving normalising to the database', () => {
    expect(parseTags('VIP, pilot  churn-risk,, ')).toEqual(['VIP', 'pilot', 'churn-risk']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags('   ')).toEqual([]);
    expect(parseTags('vip, vip')).toEqual(['vip', 'vip']);
  });
});

describe('NotesSection', () => {
  it('shows earlier notes, their tags and author, and warns not to paste guest data', async () => {
    answer([note(), note({ id: 'n2', version_id: 'n2', body: 'Pilot customer', tags: [] })]);
    show(<NotesSection orgId="org-1" />);
    expect(await screen.findByText('Promised a credit')).toBeTruthy();
    expect(screen.getByText('Pilot customer')).toBeTruthy();
    expect(screen.getByText('billing-issue')).toBeTruthy();
    expect(screen.getAllByText(/agent@queuethat.test/)).toHaveLength(2);
    expect(screen.getByText(/Don't paste guest names, phone numbers or emails/)).toBeTruthy();
  });

  it('says so when a tenant has no notes', async () => {
    answer([]);
    show(<NotesSection orgId="org-1" />);
    expect(await screen.findByText('No notes yet.')).toBeTruthy();
  });

  it('shows a load failure instead of an empty list', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'permission_denied' } });
    show(<NotesSection orgId="org-1" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No notes yet.')).toBeNull();
  });

  it('keeps Add disabled for an empty or whitespace-only note', async () => {
    answer([]);
    const user = userEvent.setup();
    show(<NotesSection orgId="org-1" />);
    await screen.findByText('No notes yet.');
    const add = screen.getByRole('button', { name: 'Add note' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Add a note'), '   ');
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Add a note'), 'hi');
    expect((add as HTMLButtonElement).disabled).toBe(false);
  });

  it('adds a note with its tags and a retry key, then clears the form', async () => {
    answer([]);
    const user = userEvent.setup();
    show(<NotesSection orgId="org-1" />);
    await screen.findByText('No notes yet.');
    await user.type(screen.getByLabelText('Add a note'), 'Onboarding call booked');
    await user.type(screen.getByLabelText('Tags'), 'VIP, pilot, vip');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(addCalls()).toHaveLength(1));
    const [, args] = addCalls()[0] as [string, Record<string, unknown>];
    expect(args).toMatchObject({
      p_org_id: 'org-1',
      p_body: 'Onboarding call booked',
      p_tags: ['VIP', 'pilot', 'vip'],
    });
    expect(args.p_idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(args).not.toHaveProperty('p_note_id');
    await waitFor(() =>
      expect((screen.getByLabelText('Add a note') as HTMLTextAreaElement).value).toBe(''),
    );
  });

  it('keeps the text and the same retry key when saving fails, and words the error', async () => {
    answer([], { error: { message: 'invalid_input' } });
    const user = userEvent.setup();
    show(<NotesSection orgId="org-1" />);
    await screen.findByText('No notes yet.');
    await user.type(screen.getByLabelText('Add a note'), 'x');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/up to 4000 characters/);
    expect((screen.getByLabelText('Add a note') as HTMLTextAreaElement).value).toBe('x');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(addCalls()).toHaveLength(2));
    expect((addCalls()[1] as [string, Record<string, unknown>])[1].p_idempotency_key).toBe(
      (addCalls()[0] as [string, Record<string, unknown>])[1].p_idempotency_key,
    );
  });

  it('caps the text at the database limit', async () => {
    answer([]);
    show(<NotesSection orgId="org-1" />);
    await screen.findByText('No notes yet.');
    expect((screen.getByLabelText('Add a note') as HTMLTextAreaElement).maxLength).toBe(4000);
  });

  it('edits a note by its stable id and tells support when it is not theirs', async () => {
    answer([note({ version: 2, version_id: 'v2' })], { error: { message: 'permission_denied' } });
    const user = userEvent.setup();
    show(<NotesSection orgId="org-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Edit note') as HTMLTextAreaElement).value).toBe(
      'Promised a credit',
    );
    expect((screen.getByLabelText('Tags') as HTMLInputElement).value).toBe('billing-issue');
    await user.type(screen.getByLabelText('Edit note'), ' and issued it');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));
    await waitFor(() => expect(addCalls()).toHaveLength(1));
    expect((addCalls()[0] as [string, Record<string, unknown>])[1]).toMatchObject({
      p_note_id: 'n1',
      p_body: 'Promised a credit and issued it',
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/your own notes/);
  });

  it('cancels an edit without writing', async () => {
    answer([note()]);
    const user = userEvent.setup();
    show(<NotesSection orgId="org-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(addCalls()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Add note' })).toBeTruthy();
    expect((screen.getByLabelText('Add a note') as HTMLTextAreaElement).value).toBe('');
  });

  it('asks for the history only when the box is ticked, and offers Edit on current versions only', async () => {
    m.rpc.mockImplementation((name: string, args: { p_include_history?: boolean }) =>
      Promise.resolve({
        data:
          name === 'platform_list_notes'
            ? args.p_include_history
              ? [
                  note({ version: 2, version_id: 'v2', body: 'Credit issued' }),
                  note({ version: 1, version_id: 'n1', body: 'Promised a credit' }),
                ]
              : [note({ version: 2, version_id: 'v2', body: 'Credit issued' })]
            : null,
        error: null,
      }),
    );
    const user = userEvent.setup();
    show(<NotesSection orgId="org-1" />);
    await screen.findByText('Credit issued');
    expect(screen.queryByText('Promised a credit')).toBeNull();
    await user.click(screen.getByLabelText('Show earlier versions'));
    const items = await screen.findAllByTestId('note');
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(items[1] as HTMLElement).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(items[0] as HTMLElement).getByText(/version 2/)).toBeTruthy();
  });

  it('keeps long unbroken text inside the page', async () => {
    answer([note({ body: 'x'.repeat(4000) })]);
    show(<NotesSection orgId="org-1" />);
    const item = await screen.findByTestId('note');
    expect(within(item).getByText('x'.repeat(4000)).className).toMatch(/break-words/);
  });
});

const tagged = (over: Partial<TaggedOrg>): TaggedOrg => ({
  org_id: 'o1',
  org_name: 'Demo Barber',
  tags: ['churn-risk'],
  needs_attention: true,
  notes: 1,
  last_note_at: '2026-11-01T10:00:00Z',
  ...over,
});

describe('TaggedTenants', () => {
  it('filters by one tag and lists every tenant that has it', async () => {
    m.rpc.mockResolvedValue({
      data: [tagged({ needs_attention: false, tags: ['vip'] })],
      error: null,
    });
    show(<TaggedTenants tag="vip" />);
    expect(await screen.findByText('Demo Barber')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tenants tagged vip' })).toBeTruthy();
    expect(m.rpc).toHaveBeenCalledWith('platform_tagged_orgs', { p_tags: ['vip'] });
  });

  it('says so when no tenant has the tag', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    show(<TaggedTenants tag="vip" />);
    expect(await screen.findByText('No tenants are tagged vip.')).toBeTruthy();
  });

  it('shows a failure', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'permission_denied' } });
    show(<TaggedTenants tag="vip" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

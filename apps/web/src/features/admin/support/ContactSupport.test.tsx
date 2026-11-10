import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberErrorId } from '../../../lib/lastError.ts';
import { collectSupportContext } from './api.ts';
import { ContactSupportButton, MESSAGE_MAX } from './ContactSupport.tsx';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  session: { current: { user: { id: 'u1' } } as unknown },
  org: { current: { id: 'org-1', name: 'Demo Barber', role: 'staff' } as unknown },
}));
vi.mock('../../../lib/supabase.ts', () => ({ supabase: { rpc: m.rpc } }));
vi.mock('../../auth/api.ts', () => ({ useSession: () => ({ data: m.session.current }) }));
vi.mock('../../auth/current.ts', () => ({ useCurrentOrg: () => m.org.current }));

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
}

function show() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ContactSupportButton />
    </QueryClientProvider>,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Contact support' }));
  return screen.findByRole('dialog');
}

/** Fills the form; the message is pasted because typing 4,000 characters one by one is slow. */
async function fill(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  subject = 'Blank screen',
  message = 'The queue page is blank.',
) {
  await user.type(within(dialog).getByLabelText('Subject'), subject);
  await user.click(within(dialog).getByLabelText('What happened?'));
  await user.paste(message);
}

beforeEach(() => {
  m.rpc.mockReset();
  m.rpc.mockResolvedValue({ data: 'SR-000042', error: null });
  m.session.current = { user: { id: 'u1' } };
  m.org.current = { id: 'org-1', name: 'Demo Barber', role: 'staff' };
  setOnline(true);
  window.history.pushState({}, '', '/admin/queues?token=SECRET#frag');
});
afterEach(() => {
  cleanup();
  delete window.__APP_CONFIG__;
});

describe('ContactSupportButton', () => {
  it('renders nothing for a signed-out visitor', () => {
    m.session.current = null;
    show();
    expect(screen.queryByRole('button', { name: 'Contact support' })).toBeNull();
  });

  it('renders nothing on a self-hosted install with no support inbox', () => {
    window.__APP_CONFIG__ = { SUPPORT_EMAIL: '' };
    show();
    expect(screen.queryByRole('button', { name: 'Contact support' })).toBeNull();
  });

  it("names a self-hosted install's own inbox to someone without a business", async () => {
    window.__APP_CONFIG__ = { SUPPORT_EMAIL: 'help@shop.example' };
    m.org.current = null;
    const user = userEvent.setup();
    show();
    const dialog = await openDialog(user);
    expect(within(dialog).getByRole('link').getAttribute('href')).toBe('mailto:help@shop.example');
  });

  it('keeps Send disabled until there is a subject and a message, and ignores blanks', async () => {
    const user = userEvent.setup();
    show();
    const dialog = await openDialog(user);
    const send = within(dialog).getByRole('button', { name: 'Send message' });
    expect(send).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByLabelText('Subject'), '   ');
    await user.click(within(dialog).getByLabelText('What happened?'));
    await user.paste('  \n ');
    expect(send).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByLabelText('Subject'), 'Hi');
    expect(send).toHaveProperty('disabled', true);
    await user.click(within(dialog).getByLabelText('What happened?'));
    await user.paste('Something');
    expect(send).toHaveProperty('disabled', false);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('sends the org from the session, trimmed text and the page without its query string', async () => {
    const user = userEvent.setup();
    show();
    const dialog = await openDialog(user);
    await fill(user, dialog, '  Blank screen ', ' The queue page is blank. ');
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(1));
    const [fn, args] = m.rpc.mock.calls[0]!;
    expect(fn).toBe('contact_support');
    expect(args).toMatchObject({
      p_org_id: 'org-1',
      p_subject: 'Blank screen',
      p_message: 'The queue page is blank.',
      p_context: { route: '/admin/queues', online: true },
    });
    expect(JSON.stringify(args)).not.toContain('SECRET');
    expect(JSON.stringify(args)).not.toContain('frag');
    expect(await within(dialog).findByText(/Your reference is SR-000042/)).toBeTruthy();
  });

  it('leaves the page out when the box is unticked', async () => {
    const user = userEvent.setup();
    show();
    const dialog = await openDialog(user);
    await fill(user, dialog);
    await user.click(within(dialog).getByLabelText("Include the page I'm on"));
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(m.rpc).toHaveBeenCalled());
    expect(m.rpc.mock.calls[0]![1].p_context).not.toHaveProperty('route');
  });

  it('sends once when the button is pressed twice', async () => {
    let resolve!: (v: unknown) => void;
    m.rpc.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    show();
    const dialog = await openDialog(user);
    await fill(user, dialog);
    const send = within(dialog).getByRole('button', { name: 'Send message' });
    await user.click(send);
    await user.click(send);
    await user.keyboard('{Enter}');
    expect(m.rpc).toHaveBeenCalledTimes(1);
    resolve({ data: 'SR-000042', error: null });
    expect(await within(dialog).findByText(/SR-000042/)).toBeTruthy();
  });

  it('offline: says so, sends nothing and keeps what was typed', async () => {
    setOnline(false);
    const user = userEvent.setup();
    show();
    const dialog = await openDialog(user);
    await fill(user, dialog, 'Offline subject', 'Offline message');
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/offline/i);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText<HTMLInputElement>('Subject').value).toBe(
      'Offline subject',
    );
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('What happened?').value).toBe(
      'Offline message',
    );
    // Back online, the same dialog sends.
    setOnline(true);
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['rate_limited', /several messages/],
    ['invalid_input', /Check the subject/],
    ['not_found', /no longer a member/],
    ['boom', /wasn't sent/],
  ])('a %s failure is explained and keeps the text for another try', async (message, expected) => {
    m.rpc.mockResolvedValue({ data: null, error: { message, code: 'P0001' } });
    const user = userEvent.setup();
    show();
    const dialog = await openDialog(user);
    await fill(user, dialog, 'Keep me', 'Keep this message');
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(expected);
    expect(within(dialog).getByLabelText<HTMLInputElement>('Subject').value).toBe('Keep me');
    expect(within(dialog).getByRole('button', { name: 'Send message' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('a network failure (the request throws) is reported, not swallowed', async () => {
    m.rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    show();
    const dialog = await openDialog(user);
    await fill(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/wasn't sent/);
  });

  it('long messages: capped at the database limit, with a counter', async () => {
    const user = userEvent.setup();
    show();
    const dialog = await openDialog(user);
    const box = within(dialog).getByLabelText<HTMLTextAreaElement>('What happened?');
    expect(box.maxLength).toBe(MESSAGE_MAX);
    expect(within(dialog).getByLabelText<HTMLInputElement>('Subject').maxLength).toBe(120);
    await fill(user, dialog, 'Long', 'x'.repeat(MESSAGE_MAX));
    expect(within(dialog).getByText('4000 of 4000 characters')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(m.rpc.mock.calls[0]![1].p_message).toHaveLength(MESSAGE_MAX));
  });

  it('a user with no business gets the support address instead of a form', async () => {
    m.org.current = undefined;
    const user = userEvent.setup();
    show();
    const dialog = await openDialog(user);
    expect(within(dialog).queryByLabelText('Subject')).toBeNull();
    const link = within(dialog).getByRole('link', { name: 'support@queuethat.com' });
    expect(link.getAttribute('href')).toBe('mailto:support@queuethat.com');
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('reopening starts with an empty form', async () => {
    const user = userEvent.setup();
    show();
    let dialog = await openDialog(user);
    await fill(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    dialog = await openDialog(user);
    expect(within(dialog).getByLabelText<HTMLInputElement>('Subject').value).toBe('');
  });
});

describe('collectSupportContext', () => {
  it('has the path only, the build, the window and the online state', () => {
    const c = collectSupportContext(true);
    expect(c.route).toBe('/admin/queues');
    expect(c.app_version).toBe('dev');
    expect(c.viewport).toEqual({ w: window.innerWidth, h: window.innerHeight });
    expect(c.online).toBe(true);
    expect(Object.keys(c).sort()).toEqual([
      'app_version',
      'browser',
      'online',
      'route',
      'viewport',
    ]);
  });

  it('adds the last error id once an error report was sent, and ignores odd ids', () => {
    rememberErrorId('bad id with spaces');
    expect(collectSupportContext(false).last_error_id).toBeUndefined();
    rememberErrorId('0123456789abcdef0123456789abcdef');
    const c = collectSupportContext(false);
    expect(c.last_error_id).toBe('0123456789abcdef0123456789abcdef');
    expect(c).not.toHaveProperty('route');
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { doneSteps, SetupChecklist, type SetupFacts } from './SetupChecklist.tsx';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

beforeAll(() => loadNamespaces('admin-setup'));
afterEach(cleanup);

const fresh: SetupFacts = {
  has_hours: false,
  has_queue: false,
  members: 1,
  pending_invitations: 0,
  devices: 0,
};

describe('doneSteps', () => {
  it('ticks each step from its own fact', () => {
    expect(doneSteps(fresh, {})).toEqual({
      line: false,
      hours: false,
      team: false,
      screen: false,
      poster: false,
    });
    expect(
      doneSteps(
        { ...fresh, has_queue: true, has_hours: true, devices: 1 },
        { posterPrinted: true },
      ),
    ).toEqual({
      line: true,
      hours: true,
      team: false,
      screen: true,
      poster: true,
    });
  });

  it('counts a pending invitation or a second member as a teammate', () => {
    expect(doneSteps({ ...fresh, pending_invitations: 1 }, {}).team).toBe(true);
    expect(doneSteps({ ...fresh, members: 2 }, {}).team).toBe(true);
  });
});

describe('SetupChecklist', () => {
  it('shows every step open for a fresh business, each linking to its page', () => {
    render(<SetupChecklist facts={fresh} progress={{}} onProgress={() => {}} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByRole('link', { name: 'Add a queue' }).getAttribute('href')).toBe(
      '/admin/queues',
    );
    expect(screen.getByRole('link', { name: 'Set hours' }).getAttribute('href')).toBe(
      '/admin/location/hours',
    );
    expect(screen.getByRole('link', { name: 'Invite staff' }).getAttribute('href')).toBe(
      '/admin/team',
    );
    expect(screen.getByRole('link', { name: 'Pair a screen' }).getAttribute('href')).toBe(
      '/admin/devices',
    );
    expect(screen.getByRole('link', { name: 'Open poster' }).getAttribute('href')).toBe(
      '/admin/poster',
    );
  });

  it('drops the action of a done step and counts it', () => {
    render(
      <SetupChecklist
        facts={{ ...fresh, has_queue: true, has_hours: true }}
        progress={{}}
        onProgress={() => {}}
      />,
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
    expect(screen.queryByRole('link', { name: 'Add a queue' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Set hours' })).toBeNull();
    expect(screen.getByText('2 of 5 done')).toBeTruthy();
  });

  it('lets the member tick the poster and hide the list', async () => {
    const onProgress = vi.fn();
    render(<SetupChecklist facts={fresh} progress={{}} onProgress={onProgress} />);
    await userEvent.click(screen.getByRole('button', { name: "I've printed it" }));
    expect(onProgress).toHaveBeenLastCalledWith({ posterPrinted: true });
    await userEvent.click(screen.getByRole('button', { name: 'Hide checklist' }));
    expect(onProgress).toHaveBeenLastCalledWith({ dismissed: true });
  });
});

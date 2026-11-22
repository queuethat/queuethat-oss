import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../../lib/i18n.ts';
import { firstTestDone, FirstTest } from './FirstTest.tsx';

const m = vi.hoisted(() => ({
  facts: undefined as undefined | { joined: boolean; called: boolean; served: boolean },
  progress: {} as { firstTestDismissed?: boolean },
  role: 'owner',
  update: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../../../auth/current.ts', () => ({
  useCurrentLocation: () => ({ location: { id: 'loc-a', slug: 'main-st' } }),
  useCurrentOrg: () => ({ id: 'org-a', role: m.role }),
}));
vi.mock('./api.ts', () => ({
  useFirstTestFacts: (orgId: string | undefined) => ({ data: orgId ? m.facts : undefined }),
  useSetupProgress: () => ({ progress: m.progress, update: m.update }),
}));

beforeAll(() => loadNamespaces('admin-setup'));
beforeEach(() => {
  m.facts = { joined: false, called: false, served: false };
  m.progress = {};
  m.role = 'owner';
  m.update.mockReset();
});
afterEach(cleanup);

const doneCount = () => document.querySelectorAll('li[data-done="true"]').length;

describe('firstTestDone', () => {
  it('ticks join from a visit, call from a called visit, and open from either', () => {
    const none = { joined: false, called: false, served: false };
    expect(firstTestDone(none, false)).toEqual({ open: false, join: false, call: false });
    expect(firstTestDone(none, true)).toEqual({ open: true, join: false, call: false });
    expect(firstTestDone({ ...none, joined: true }, false)).toEqual({
      open: true,
      join: true,
      call: false,
    });
    expect(firstTestDone({ joined: true, called: true, served: false }, false)).toEqual({
      open: true,
      join: true,
      call: true,
    });
  });
});

describe('FirstTest', () => {
  it('starts with nothing done and links to the join page and the console', () => {
    render(<FirstTest />);
    expect(doneCount()).toBe(0);
    expect(screen.getByRole('link', { name: 'Open join page' }).getAttribute('href')).toMatch(
      /\/q\/main-st$/,
    );
    expect(screen.getByRole('link', { name: 'Open console' }).getAttribute('href')).toBe('/staff');
  });

  it('ticks the join steps once a visit exists, then the call step once one is called', () => {
    m.facts = { joined: true, called: false, served: false };
    const { rerender } = render(<FirstTest />);
    expect(doneCount()).toBe(2);
    m.facts = { joined: true, called: true, served: false };
    rerender(<FirstTest />);
    expect(doneCount()).toBe(3);
    expect(screen.getByText('Your line works')).toBeTruthy();
  });

  it('can be skipped, and the choice is saved', async () => {
    render(<FirstTest />);
    await userEvent.click(screen.getByRole('button', { name: 'Skip the test' }));
    expect(m.update).toHaveBeenCalledWith({ firstTestDismissed: true });
  });

  it('stays hidden when dismissed, when a visit has been served, while loading, and for staff', () => {
    m.progress = { firstTestDismissed: true };
    const { container, rerender } = render(<FirstTest />);
    expect(container.textContent).toBe('');
    m.progress = {};
    m.facts = { joined: true, called: true, served: true };
    rerender(<FirstTest />);
    expect(container.textContent).toBe('');
    m.facts = undefined;
    rerender(<FirstTest />);
    expect(container.textContent).toBe('');
    m.facts = { joined: false, called: false, served: false };
    m.role = 'staff';
    rerender(<FirstTest />);
    expect(container.textContent).toBe('');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<FirstTest />);
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

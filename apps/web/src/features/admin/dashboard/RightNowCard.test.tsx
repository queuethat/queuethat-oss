import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { RightNowCard } from './RightNowCard.tsx';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

beforeAll(() => loadNamespaces('admin'));
afterEach(cleanup);

type Visit = Parameters<typeof RightNowCard>[0]['visits'][number];

const visit = (n: number, over: Partial<Visit> = {}): Visit => ({
  id: `v${n}`,
  ticket: `A00${n}`,
  status: 'waiting',
  name: `Guest ${n}`,
  service: 'Haircut',
  joinedAt: '2026-11-08T17:00:00Z',
  ...over,
});

describe('RightNowCard', () => {
  it('names the line and shows the first three guests with a link to the live queue', () => {
    render(
      <RightNowCard visits={[visit(1), visit(2), visit(3), visit(4), visit(5)]} timeZone="UTC" />,
    );
    expect(screen.getByTestId('right-now-count').textContent).toBe('5 people waiting');
    const list = screen.getByRole('list', { name: 'Next in line' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('A001')).toBeTruthy();
    expect(screen.getByText('+2 more')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open live queue' }).getAttribute('href')).toBe(
      '/staff',
    );
  });

  it('shows the joined time in the location time zone', () => {
    render(<RightNowCard visits={[visit(1)]} timeZone="America/New_York" />);
    expect(screen.getByText(/Joined 12:00\s?PM/)).toBeTruthy();
  });

  it('counts only guests who are waiting, not those called or being served', () => {
    render(
      <RightNowCard
        visits={[visit(1), visit(2, { status: 'called' }), visit(3, { status: 'serving' })]}
        timeZone="UTC"
      />,
    );
    expect(screen.getByTestId('right-now-count').textContent).toBe('1 person waiting');
  });

  it('says so when no one is waiting and keeps the hand-off', () => {
    render(<RightNowCard visits={[]} timeZone="UTC" />);
    expect(screen.getByTestId('right-now-count').textContent).toBe('No one is waiting.');
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open live queue' })).toBeTruthy();
  });

  it('labels an anonymous walk-in', () => {
    render(<RightNowCard visits={[visit(1, { name: null })]} timeZone="UTC" />);
    expect(screen.getByText('Walk-in')).toBeTruthy();
  });
});

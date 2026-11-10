import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { ArriveBy, Snooze } from './Snooze.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeAll(() => loadNamespaces('guest-snooze')); // a lazy namespace, loaded with the buttons

const base = {
  display_ticket: 'A001',
  status: 'called',
  guest_actions: ['leave', 'on_my_way', 'need_more_time'],
  grace_until: '2026-10-30T10:05:00Z',
  warn_at: '2026-10-30T10:04:00Z',
  snoozes_left: 1,
  on_the_way: false,
} as never;
const at = (iso: string) =>
  vi.useFakeTimers({ now: Date.parse(iso), toFake: ['Date', 'setInterval'] });

describe('ArriveBy', () => {
  it('shows the deadline and keeps the live warning empty before warn_at', () => {
    at('2026-10-30T10:00:00Z');
    render(<ArriveBy visit={base} />);
    expect(screen.getByTestId('arrive-by').textContent).toMatch(/^Please arrive by /);
    expect(screen.getByTestId('arrive-warning').textContent).toBe('');
  });

  it('warns, with the minutes left, once warn_at has passed', () => {
    at('2026-10-30T10:04:30Z');
    render(<ArriveBy visit={base} />);
    expect(screen.getByTestId('arrive-warning').textContent).toContain('in 1 minute');
  });

  it('says so when the deadline itself has passed, and shows nothing for a waiting guest', () => {
    at('2026-10-30T10:05:30Z');
    const { rerender } = render(<ArriveBy visit={base} />);
    expect(screen.getByTestId('arrive-warning').textContent).toContain('about to be given away');
    rerender(
      <ArriveBy visit={{ ...(base as object), status: 'waiting', grace_until: null } as never} />,
    );
    expect(screen.queryByTestId('arrive-by')).toBeNull();
  });
});

describe('Snooze', () => {
  const view = (visit: object) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Snooze token="t" visit={{ ...(base as object), ...visit } as never} />
      </QueryClientProvider>,
    );

  it('offers only what the database offers, and disables extensions at the limit', () => {
    at('2026-10-30T10:00:00Z');
    view({ snoozes_left: 0 });
    expect(
      (screen.getByRole('button', { name: "I'm on my way" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'I need more time' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId('snoozes-left').textContent).toBe('No more extensions');
  });

  it('shows no buttons for actions the database does not offer', () => {
    view({ status: 'waiting', guest_actions: ['leave'], grace_until: null });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a waiting guest only the extension, with how many are left', () => {
    view({
      status: 'waiting',
      guest_actions: ['leave', 'need_more_time'],
      grace_until: null,
      snoozes_left: 2,
    });
    expect(screen.queryByRole('button', { name: "I'm on my way" })).toBeNull();
    expect(screen.getByTestId('snoozes-left').textContent).toContain('2 extensions left');
  });
});

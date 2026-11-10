import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { JoinWait } from './JoinWait.tsx';

afterEach(cleanup);

const base = {
  queue_id: 'q',
  queue_name: 'Walk-ins',
  accepting: true,
  waiting_count: 4,
  eta_state: 'ok' as const,
  eta_low: 20,
  eta_high: 30,
  opens_next_at: null,
  party_size_min: null,
  party_size_max: null,
  intake_fields: [],
  join_later_max_hours: null,
  as_of: new Date().toISOString(),
};

describe('JoinWait', () => {
  it('words the estimate and the people waiting', () => {
    render(<JoinWait wait={base} tz="UTC" updatedAt={Date.now()} />);
    expect(screen.getByTestId('join-wait').textContent).toBe('About 20–30 min, 4 waiting');
  });

  it('shows only the count when the queue hides its estimate', () => {
    render(
      <JoinWait
        wait={{ ...base, eta_state: 'hidden', eta_low: null, eta_high: null, waiting_count: 1 }}
        tz="UTC"
        updatedAt={Date.now()}
      />,
    );
    expect(screen.getByTestId('join-wait').textContent).toBe('1 waiting');
  });

  it('says when a closed location opens, in its own time zone (AC2)', () => {
    const opens = '2030-01-15T14:00:00Z'; // 9:00 in New York
    render(
      <JoinWait
        wait={{ ...base, accepting: false, opens_next_at: opens }}
        tz="America/New_York"
        updatedAt={Date.now()}
      />,
    );
    expect(screen.getByTestId('join-wait').textContent).toMatch(/^Opens \w+ at 9:00\s?AM$/);
  });

  it('greys out and gives "as of" once the data is over two minutes old', () => {
    render(<JoinWait wait={base} tz="UTC" updatedAt={Date.now() - 3 * 60_000} />);
    expect(screen.getByText(/^As of /)).toBeTruthy();
    expect(screen.getByTestId('join-wait').className).toContain('opacity-60');
  });

  it('shows nothing for a queue that is not accepting and has no opening time', () => {
    const { container } = render(
      <JoinWait wait={{ ...base, accepting: false }} tz="UTC" updatedAt={Date.now()} />,
    );
    expect(container.textContent).toBe('');
  });
});

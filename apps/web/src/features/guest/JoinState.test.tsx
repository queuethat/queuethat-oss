import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { JoinStateBanner } from './JoinState.tsx';

afterEach(cleanup);

describe('JoinStateBanner', () => {
  it.each([
    ['paused', 'paused', 'Paused', 'This queue is paused. Please check back in a few minutes.'],
    ['closed', 'closed', 'Closed', 'This queue is closed right now.'],
    ['outside_hours', 'closed', 'Closed', 'This queue is outside its opening hours.'],
    ['full', 'full', 'Full', 'This queue is full right now. Please check back soon.'],
    [
      'online_full',
      'full',
      'Full',
      "This queue isn't taking more online joins right now. Please check in at the front desk.",
    ],
  ] as const)('%s wears the %s look with a text label', (reason, look, label, sentence) => {
    render(<JoinStateBanner reason={reason} />);
    const banner = screen.getByTestId('join-state');
    expect(banner.dataset.state).toBe(look);
    expect(banner.textContent).toContain(label);
    expect(banner.textContent).toContain(sentence);
    expect(banner.querySelector('svg')).not.toBeNull(); // an icon too, so colour is never the only cue
  });
});

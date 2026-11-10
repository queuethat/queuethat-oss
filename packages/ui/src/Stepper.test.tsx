import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState.tsx';
import { iconUsers } from './icons.ts';
import { Skeleton } from './Skeleton.tsx';
import { Stepper } from './Stepper.tsx';

afterEach(cleanup);

describe('Stepper', () => {
  it('marks the current step and counts done steps', () => {
    render(<Stepper label="Setup" steps={['Business', 'Location', 'Queue']} current={1} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((i) => i.dataset.state)).toEqual(['done', 'current', 'todo']);
    expect(items[1]?.getAttribute('aria-current')).toBe('step');
    expect(items[0]?.getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('list', { name: 'Setup' })).toBeTruthy();
  });
});

describe('Skeleton', () => {
  it('is a named busy region with the requested rows and no motion without preference', () => {
    const { container } = render(<Skeleton label="Loading guests" rows={2} />);
    const region = screen.getByRole('status', { name: 'Loading guests' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(region.children).toHaveLength(2);
    expect(container.innerHTML).toContain('motion-safe:animate-pulse');
    expect(container.innerHTML).not.toMatch(/(^|[ "])animate-pulse/);
  });
});

describe('EmptyState v2', () => {
  it('keeps the old contract', () => {
    render(
      <EmptyState
        title="Nothing"
        description="Add one"
        action={<button type="button">Add</button>}
      />,
    );
    expect(screen.getByText('Nothing')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });

  it('shows the reason, icon and secondary action', () => {
    const { container } = render(
      <EmptyState
        title="No guests"
        icon={iconUsers}
        reason="Guests appear after they join."
        action={<button type="button">Share</button>}
        secondary={<a href="/help">Learn more</a>}
      />,
    );
    expect(screen.getByText('Guests appear after they join.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Learn more' })).toBeTruthy();
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

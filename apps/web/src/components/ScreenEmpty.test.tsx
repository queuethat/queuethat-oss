import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNamespaces } from '../lib/i18n.ts';
import { ScreenEmpty, type EmptyKind } from './ScreenEmpty.tsx';

beforeAll(() => loadNamespaces('empty'));
afterEach(cleanup);

const COPY: Record<EmptyKind, [string, string]> = {
  console: ['No one is waiting', 'Share your line and guests will appear here.'],
  queues: ['No queues yet', 'A queue is a line guests can join.'],
  counters: ['No counters yet', 'A counter is a desk, chair or table where a guest is served.'],
  team: ["It's just you", 'Invite someone to run the line.'],
  devices: ['No screens paired', 'Pair a TV to show who is next.'],
  guests: ['No guests yet', 'This fills in after your first visits.'],
  analytics: ['No numbers yet', 'This fills in after your first visits.'],
  feedback: ['No feedback yet', 'This fills in after your first visits.'],
  developers: [
    'Nothing here yet',
    'Keys and webhooks let other software read and update your queues. Most businesses never need them.',
  ],
};

describe('ScreenEmpty', () => {
  it.each(Object.entries(COPY))('%s says what it is and why it is empty', (kind, [title, why]) => {
    const { container } = render(<ScreenEmpty kind={kind as EmptyKind} />);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(why)).toBeTruthy();
    // The icon is decoration.
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the actions it is given', () => {
    render(
      <ScreenEmpty
        kind="queues"
        action={<button type="button">Add your first queue</button>}
        secondary={<a href="/admin/templates">Use a template</a>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Add your first queue' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Use a template' })).toBeTruthy();
  });
});

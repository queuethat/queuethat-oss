import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnouncementBanner, type AnnouncementSeverity } from './AnnouncementBanner.tsx';

afterEach(cleanup);

function setup(severity: AnnouncementSeverity) {
  const onDismiss = vi.fn();
  render(
    <AnnouncementBanner
      severity={severity}
      label="Notice"
      message="Card readers are down"
      dismissLabel="Dismiss"
      onDismiss={onDismiss}
    />,
  );
  return { onDismiss };
}

describe('AnnouncementBanner', () => {
  it('lets an info announcement be dismissed', async () => {
    const { onDismiss } = setup('info');
    expect(screen.getByText('Card readers are down', { exact: false }).textContent).toBe(
      'Notice: Card readers are down',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it.each(['warning', 'maintenance'] as const)('offers no dismiss for %s', (severity) => {
    setup(severity);
    expect(screen.getByRole('status').dataset.severity).toBe(severity);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../../lib/i18n.ts';
import type { ConsoleQueue } from '../api.ts';
import { WaitOverride } from './WaitOverride.tsx';

vi.mock('../api.ts', () => ({
  useSetWaitOverride: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

beforeAll(() => loadNamespaces('staff'));
afterEach(cleanup);

const inThirtyMinutes = () => new Date(Date.now() + 30 * 60_000).toISOString();
const queue = (over: Partial<ConsoleQueue> = {}) =>
  ({
    id: 'q1',
    name: 'Walk-ins',
    waitOverrideMinutes: 30,
    waitOverrideUntil: inThirtyMinutes(),
    ...over,
  }) as ConsoleQueue;

describe('WaitOverride', () => {
  it('shows the notice and the button together by default', () => {
    render(<WaitOverride queue={queue()} timeZone="UTC" />);
    expect(screen.getByTestId('wait-override-banner')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set wait' })).toBeTruthy();
  });

  it('shows only the active notice, with its Clear button, as the banner part', () => {
    render(<WaitOverride part="banner" queue={queue()} timeZone="UTC" />);
    expect(screen.getByTestId('wait-override-banner').textContent).toMatch(/30 min/);
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set wait' })).toBeNull();
  });

  it('shows only the button, even while an override is active, as the action part', () => {
    render(<WaitOverride part="action" queue={queue()} timeZone="UTC" />);
    expect(screen.queryByTestId('wait-override-banner')).toBeNull();
    expect(screen.getByRole('button', { name: 'Set wait' })).toBeTruthy();
  });

  it('shows no notice once the override has expired', () => {
    const expired = queue({ waitOverrideUntil: new Date(Date.now() - 60_000).toISOString() });
    render(<WaitOverride part="banner" queue={expired} timeZone="UTC" />);
    expect(screen.queryByTestId('wait-override-banner')).toBeNull();
  });

  it('shows no notice when no override is set', () => {
    const none = queue({ waitOverrideMinutes: null, waitOverrideUntil: null });
    render(<WaitOverride queue={none} timeZone="UTC" />);
    expect(screen.queryByTestId('wait-override-banner')).toBeNull();
    expect(screen.getByRole('button', { name: 'Set wait' })).toBeTruthy();
  });
});

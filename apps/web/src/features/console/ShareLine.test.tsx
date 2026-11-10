import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNamespaces } from '../../lib/i18n.ts';
import { ShareLine } from './ShareLine.tsx';

vi.mock('../auth/current.ts', () => ({
  useCurrentLocation: () => ({ location: { slug: 'demo-barber' }, locations: [] }),
}));

beforeAll(() => loadNamespaces('empty'));
afterEach(cleanup);

describe('ShareLine', () => {
  it('copies the join link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ShareLine />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy join link' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/q/demo-barber'));
    expect(await screen.findByText('Link copied.')).toBeTruthy();
  });

  it('shows the QR for the join page in a dialog', async () => {
    render(<ShareLine />);
    await userEvent.click(screen.getByRole('button', { name: 'Show QR code' }));
    expect(await screen.findByRole('img', { name: /QR code for .*\/q\/demo-barber/ })).toBeTruthy();
  });
});

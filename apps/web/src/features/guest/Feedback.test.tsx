import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../../lib/i18n.ts';
import strings from '../../locales/en/guest-feedback.json';
import { Feedback } from './Feedback.tsx';
import { guestRpc, RpcError } from './client.ts';

vi.mock('./client.ts', async (orig) => ({
  ...(await orig<typeof import('./client.ts')>()),
  guestRpc: vi.fn(),
}));
afterEach(cleanup);
// Added directly, not through the lazy loader: a warm Vite glob cache predates this file and finds nothing.
beforeAll(() => {
  i18n.addResourceBundle('en', 'guest-feedback', strings, true, true);
});

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Feedback token="tok" />
    </QueryClientProvider>,
  );

describe('Feedback', () => {
  it('sends the chosen rating and thanks the guest', async () => {
    vi.mocked(guestRpc).mockResolvedValue({ submitted: true, already_submitted: false } as never);
    show();
    const send = screen.getByRole('button', { name: 'Send feedback' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '5 of 5 stars' }));
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByTestId('feedback-thanks')).toBeTruthy());
    expect(guestRpc).toHaveBeenCalledWith(
      'guest_submit_feedback',
      expect.objectContaining({ p_token: 'tok', p_rating: 5, p_comment: null }),
    );
  });

  it('says so when the database refuses with not_found', async () => {
    vi.mocked(guestRpc).mockRejectedValue(new RpcError('not_found', 'P0001', null, 400));
    show();
    fireEvent.click(screen.getByRole('radio', { name: '3 of 5 stars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    await waitFor(() => expect(screen.getByText(/isn't available/)).toBeTruthy());
  });
});

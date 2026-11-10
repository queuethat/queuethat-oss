import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { queryClient } from '../../lib/query.ts';
import { createAppRouter } from '../../router.tsx';

// Every sign-in and sign-up screen sits in AuthCard, so the brand lockup is checked there: the mark
// beside the wordmark, decorative (the wordmark already names the product).

vi.mock('../../lib/supabase.ts', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(),
    },
  },
}));

afterEach(cleanup);

it.each(['/auth/sign-in', '/auth/sign-up'])(
  'shows the mark beside the wordmark on %s',
  async (path) => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
    await router.load();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const wordmark = await screen.findByText('QueueThat');
    const mark = wordmark.parentElement!.querySelector('svg');
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute('aria-hidden')).toBe('true');
    expect(mark!.getAttribute('width')).toBe('36');
    // The accessible name stays the plain wordmark: the decorative mark adds nothing to it.
    expect(wordmark.parentElement!.textContent).toBe('QueueThat');
  },
);

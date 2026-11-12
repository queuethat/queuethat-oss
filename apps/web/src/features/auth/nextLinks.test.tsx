import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { queryClient } from '../../lib/query.ts';
import { createAppRouter } from '../../router.tsx';

// The links between the auth screens pass `next` along, but not when it is the default landing
// page: the sign-up address is then plain `/auth/sign-up`, not `/auth/sign-up?next=%2Fstaff`.

vi.mock('../../lib/supabase.ts', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(),
    },
  },
}));

afterEach(cleanup);

async function hrefOf(at: string, linkName: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [at] }));
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return (await screen.findByRole('link', { name: linkName })).getAttribute('href');
}

it.each([
  ['/auth/sign-in', 'Create an account', '/auth/sign-up'],
  ['/auth/sign-in?next=%2Fstaff', 'Create an account', '/auth/sign-up'],
  ['/auth/sign-up', 'Sign in', '/auth/sign-in'],
  ['/auth/sign-up?next=%2Fstaff', 'Sign in', '/auth/sign-in'],
])('%s links to %s without ?next= when it is the default', async (at, linkName, href) => {
  expect(await hrefOf(at, linkName)).toBe(href);
});

it.each([
  ['/auth/sign-in?next=%2Fadmin%2Fusage', 'Create an account', '/auth/sign-up'],
  ['/auth/sign-up?next=%2Fadmin%2Fusage', 'Sign in', '/auth/sign-in'],
])('%s keeps a ?next= that is not the default', async (at, linkName, path) => {
  const href = await hrefOf(at, linkName);
  const url = new URL(href!, 'http://localhost');
  expect(url.pathname).toBe(path);
  expect(url.searchParams.get('next')).toBe('/admin/usage');
});

import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from './lib/query.ts';
import { createAppRouter } from './router.tsx';

async function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return container;
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('public pages', () => {
  it('/ is not a marketing page: signed-out visitors land on sign-in', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://db.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test');
    await renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  it.each([
    ['/terms', 'https://queuethat.com/terms'],
    ['/privacy', 'https://queuethat.com/privacy'],
  ])('%s hands over to the marketing site', async (path, url) => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace });
    await renderAt(path);
    expect(
      (await screen.findByRole('link', { name: 'Continue to queuethat.com' })).getAttribute('href'),
    ).toBe(url);
    expect(replace).toHaveBeenCalledWith(url);
  });

  it('sign-up shows a consent line linking the Terms and the Privacy Policy', async () => {
    await renderAt('/auth/sign-up');
    const line = await screen.findByTestId('signup-consent');
    expect(line.querySelector('a[href="https://queuethat.com/terms"]')).not.toBeNull();
    expect(line.querySelector('a[href="https://queuethat.com/privacy"]')).not.toBeNull();
  });
});

describe('route groups', () => {
  it.each([
    ['/auth/sign-in', 'auth', 'Sign in'],
    // Unpaired browsers get the pairing screen (D3, #50); tests/e2e/device.spec.ts pairs them.
    ['/display', 'display', 'Pair this screen'],
    ['/kiosk', 'kiosk', 'Pair this screen'],
  ])('%s renders its placeholder inside the %s layout', async (path, layout, title) => {
    const container = await renderAt(path);
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    expect(container.querySelector(`[data-layout="${layout}"]`)).not.toBeNull();
  });

  it('/v/:token renders the status page inside the guest layout', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://db.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ display_ticket: 'A001', status: 'waiting', position: 1 })),
    );
    const container = await renderAt('/v/some-token');
    expect(await screen.findByRole('heading', { name: 'Your place in line' })).toBeTruthy();
    expect(container.querySelector('[data-layout="guest"]')).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it('/pay/:code renders the pay page inside the guest layout, with no sign-in', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://db.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'not_found' }, { status: 404 })),
    );
    const container = await renderAt('/pay/ABCD2345');
    expect(
      await screen.findByRole('heading', { name: 'This payment link has ended' }),
    ).toBeTruthy();
    expect(container.querySelector('[data-layout="guest"]')).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it('/auth redirects to sign-in and keeps ?next=', async () => {
    const router = createAppRouter(
      createMemoryHistory({ initialEntries: ['/auth?next=%2Fstaff'] }),
    );
    await router.load();
    expect(router.state.location.pathname).toBe('/auth/sign-in');
    expect(router.state.location.search).toEqual({ next: '/staff' });
  });

  // A2 (#42): signed out, the staff and admin areas send you to sign-in and remember the way back.
  it.each(['/staff', '/admin', '/onboarding'])(
    '%s redirects a signed-out user to sign-in',
    async (path) => {
      const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
      await router.load();
      render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
      expect(router.state.location.pathname).toBe('/auth/sign-in');
      expect(router.state.location.search).toEqual({ next: path });
    },
  );

  it('/q/demo-barber renders the join page inside the guest layout', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://db.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(
          url.endsWith('/get_location_wait') || url.endsWith('/get_location_lines')
            ? []
            : { name: 'Demo Barber', queues: [] },
        ),
      ),
    );
    const container = await renderAt('/q/demo-barber');
    expect(await screen.findByRole('heading', { name: 'Join the queue' })).toBeTruthy();
    expect(container.querySelector('[data-layout="guest"]')).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it('renders the catalogue at /dev/ui', async () => {
    await renderAt('/dev/ui');
    expect(await screen.findByRole('heading', { name: 'UI catalogue' })).toBeTruthy();
  });

  it('answers 404 at /dev/ui in production builds', async () => {
    vi.stubEnv('DEV', false);
    await renderAt('/dev/ui');
    expect(await screen.findByTestId('not-found')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'UI catalogue' })).toBeNull();
  });

  it('renders 404 for unknown paths', async () => {
    await renderAt('/no-such-page');
    expect(await screen.findByTestId('not-found')).toBeTruthy();
  });
});

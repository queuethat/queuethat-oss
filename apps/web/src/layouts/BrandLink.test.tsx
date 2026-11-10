import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { BrandLink } from './BrandLink.tsx';

// The brand lockup in the staff and admin header: mark beside the name, decorative mark, and a link
// to the front door except where that link would go nowhere.

afterEach(cleanup);

async function show(linked?: boolean) {
  const root = createRootRoute({ component: () => <BrandLink linked={linked ?? true} /> });
  const staff = createRoute({ getParentRoute: () => root, path: '/staff' });
  const router = createRouter({
    routeTree: root.addChildren([staff]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return await screen.findByText('QueueThat');
}

it('shows the mark beside the name and links to /staff', async () => {
  const name = await show();
  const link = screen.getByRole('link', { name: 'QueueThat' });
  expect(link.getAttribute('href')).toBe('/staff');
  expect(link.contains(name)).toBe(true);

  const mark = link.querySelector('svg')!;
  expect(mark.getAttribute('aria-hidden')).toBe('true');
  expect(mark.getAttribute('width')).toBe('36');
  // The accessible name is the plain name: the decorative mark adds nothing to it.
  expect(link.textContent).toBe('QueueThat');
});

it('is plain text, still with the mark, when it is not linked', async () => {
  const name = await show(false);
  expect(screen.queryByRole('link')).toBeNull();
  expect(name.parentElement!.querySelector('svg')).not.toBeNull();
});

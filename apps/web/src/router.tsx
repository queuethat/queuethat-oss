import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { queryClient } from './lib/query.ts';
import { routeTree } from './routeTree.gen.ts';

/** Builds the app router. Tests pass a memory history; the app uses the browser default. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
    ...(history ? { history } : {}),
  });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

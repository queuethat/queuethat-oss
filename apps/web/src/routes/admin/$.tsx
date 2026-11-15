import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { redirectFor } from '../../extensions/index.ts';

// Any other /admin address: an old one an installed extension took over redirects to its page
// (src/extensions `redirects`); anything else is not found, as before. None are installed here.
export const Route = createFileRoute('/admin/$')({
  beforeLoad: ({ location }) => {
    const to = redirectFor(location.pathname);
    if (!to) throw notFound();
    throw redirect({ href: `${to}${location.searchStr}`, replace: true });
  },
});

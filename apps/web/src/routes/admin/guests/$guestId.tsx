import { createFileRoute, redirect } from '@tanstack/react-router';
import { redirectFor } from '../../../extensions/index.ts';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { GuestProfilePage } from '../../../features/admin/guests/GuestProfilePage.tsx';

export const Route = createFileRoute('/admin/guests/$guestId')({
  // `/admin/guests/import` and `/duplicates` once had their own routes; an installed extension that
  // took them over redirects here, before the id is taken for a guest.
  beforeLoad: ({ location }) => {
    const to = redirectFor(location.pathname);
    if (to) throw redirect({ href: `${to}${location.searchStr}`, replace: true });
    return loadNamespaces('admin-guests');
  },
  component: function GuestProfile() {
    const { guestId } = Route.useParams();
    return <GuestProfilePage guestId={guestId} />;
  },
});

import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { GuestProfilePage } from '../../../features/admin/guests/GuestProfilePage.tsx';

export const Route = createFileRoute('/admin/guests/$guestId')({
  beforeLoad: () => loadNamespaces('admin-guests', 'crm'),
  component: function GuestProfile() {
    const { guestId } = Route.useParams();
    return <GuestProfilePage guestId={guestId} />;
  },
});

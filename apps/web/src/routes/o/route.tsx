import { createFileRoute } from '@tanstack/react-router';
import { GuestLayout } from '../../layouts/GuestLayout.tsx';
import { loadNamespaces } from '../../lib/i18n.ts';

// `/o/:token` links are sent to guests (the waitlist offer page). Never rename or move it.
export const Route = createFileRoute('/o')({
  beforeLoad: () => loadNamespaces('booking'),
  component: GuestLayout,
});

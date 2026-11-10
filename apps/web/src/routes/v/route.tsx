import { createFileRoute } from '@tanstack/react-router';
import { GuestLayout } from '../../layouts/GuestLayout.tsx';
import { loadNamespaces } from '../../lib/i18n.ts';

// `/v/:token` links are sent to guests. Never rename or move it.
export const Route = createFileRoute('/v')({
  beforeLoad: () => loadNamespaces('guest-status'),
  component: GuestLayout,
});

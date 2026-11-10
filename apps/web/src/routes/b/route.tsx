import { createFileRoute } from '@tanstack/react-router';
import { GuestLayout } from '../../layouts/GuestLayout.tsx';
import { loadNamespaces } from '../../lib/i18n.ts';

// `/b/:locationSlug` is printed on posters and bookmarked. Never rename or move it.
export const Route = createFileRoute('/b')({
  beforeLoad: () => loadNamespaces('booking'),
  component: GuestLayout,
});

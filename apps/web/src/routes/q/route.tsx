import { createFileRoute } from '@tanstack/react-router';
import { GuestLayout } from '../../layouts/GuestLayout.tsx';
import { loadNamespaces } from '../../lib/i18n.ts';

// `/q/:locationSlug` is printed on QR posters. Never rename or move it.
export const Route = createFileRoute('/q')({
  beforeLoad: () => loadNamespaces('guest-join'),
  component: GuestLayout,
});

import { createFileRoute } from '@tanstack/react-router';
import { GuestLayout } from '../../layouts/GuestLayout.tsx';
import { loadNamespaces } from '../../lib/i18n.ts';

// `/pay/:code` is what the staff tablet's QR encodes (4-PAY2). It is new, so it may be printed on
// nothing, but a code on a guest's screen is still a link: keep the path.
export const Route = createFileRoute('/pay')({
  beforeLoad: () => loadNamespaces('booking'),
  component: GuestLayout,
});

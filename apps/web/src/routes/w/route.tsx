import { createFileRoute, Outlet } from '@tanstack/react-router';
import { WidgetFrame } from '../../features/widget/WidgetFrame.tsx';
import { loadNamespaces } from '../../lib/i18n.ts';

// `/w/:locationSlug` is the embeddable join page. Unlike every other route it may be framed by
// any site (public/_headers, vercel.json and the Caddyfile say so). Never rename or move it.
export const Route = createFileRoute('/w')({
  beforeLoad: () => loadNamespaces('guest-join'),
  component: () => (
    <WidgetFrame>
      <Outlet />
    </WidgetFrame>
  ),
});

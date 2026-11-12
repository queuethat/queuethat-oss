import { createFileRoute, notFound } from '@tanstack/react-router';
import { ExtensionAdminPage } from '../../extensions/ExtensionAdminPage.tsx';
import { findAdminPage } from '../../extensions/index.ts';

// Admin pages a deployment adds without editing this app (src/extensions). None are installed here,
// so every /admin/x/... address is not found.
export const Route = createFileRoute('/admin/x/$')({
  beforeLoad: ({ params }) => {
    const page = findAdminPage(params._splat);
    if (!page) throw notFound();
    return { extensionPage: page };
  },
  component: function ExtensionRoute() {
    const { extensionPage } = Route.useRouteContext();
    return <ExtensionAdminPage path={extensionPage.path} />;
  },
});

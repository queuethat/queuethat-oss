import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { HelpPage } from '../../features/admin/support/HelpPage.tsx';

export const Route = createFileRoute('/admin/help')({
  beforeLoad: () => loadNamespaces('admin-support'),
  component: HelpPage,
});

import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { ProvidersPage } from '../../features/admin/integrations/providers/ProvidersPage.tsx';

export const Route = createFileRoute('/admin/integrations')({
  beforeLoad: () => loadNamespaces('admin-integrations', 'admin-templates'),
  component: ProvidersPage,
});

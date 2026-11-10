import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { RolesPage } from '../../features/admin/roles/RolesPage.tsx';

export const Route = createFileRoute('/admin/roles')({
  beforeLoad: () => loadNamespaces('admin-roles'),
  component: RolesPage,
});

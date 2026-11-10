import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { TemplatesPage } from '../../features/admin/templates/TemplatesPage.tsx';

export const Route = createFileRoute('/admin/templates')({
  beforeLoad: () => loadNamespaces('admin-templates'),
  component: TemplatesPage,
});

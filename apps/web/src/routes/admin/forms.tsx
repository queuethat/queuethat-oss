import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { FormsPage } from '../../features/admin/forms/FormsPage.tsx';

export const Route = createFileRoute('/admin/forms')({
  beforeLoad: () => loadNamespaces('admin-forms'),
  component: FormsPage,
});

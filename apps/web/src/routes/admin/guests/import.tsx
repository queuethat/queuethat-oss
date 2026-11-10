import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { ImportPage } from '../../../features/crm/import/ImportPage.tsx';

export const Route = createFileRoute('/admin/guests/import')({
  beforeLoad: () => loadNamespaces('admin-guests', 'crm'),
  component: ImportPage,
});

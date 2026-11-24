import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { DuplicatesPage } from '../../../features/crm/merge/DuplicatesPage.tsx';

export const Route = createFileRoute('/admin/guests/duplicates')({
  beforeLoad: () => loadNamespaces('admin-guests', 'crm'),
  component: DuplicatesPage,
});

import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { RequestsPage } from '../../../features/admin/privacy/requests/RequestsPage.tsx';

export const Route = createFileRoute('/admin/privacy/requests')({
  beforeLoad: () => loadNamespaces('admin-privacy'),
  component: RequestsPage,
});

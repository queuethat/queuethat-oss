import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { SupportPage } from '../../../features/admin/support/SupportPage.tsx';

export const Route = createFileRoute('/admin/settings/support')({
  beforeLoad: () => loadNamespaces('admin-support'),
  component: SupportPage,
});

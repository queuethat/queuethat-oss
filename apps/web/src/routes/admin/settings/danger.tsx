import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { DangerZonePage } from '../../../features/admin/settings/danger/DangerZonePage.tsx';

export const Route = createFileRoute('/admin/settings/danger')({
  beforeLoad: () => loadNamespaces('admin-privacy'),
  component: DangerZonePage,
});

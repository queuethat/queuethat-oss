import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { TeamPage } from '../../features/admin/team/TeamPage.tsx';

export const Route = createFileRoute('/admin/team')({
  beforeLoad: () => loadNamespaces('admin-team'),
  component: TeamPage,
});

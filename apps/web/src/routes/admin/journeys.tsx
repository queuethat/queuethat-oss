import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { JourneysPage } from '../../features/admin/journeys/JourneysPage.tsx';

export const Route = createFileRoute('/admin/journeys')({
  beforeLoad: () => loadNamespaces('admin-journeys'),
  component: JourneysPage,
});

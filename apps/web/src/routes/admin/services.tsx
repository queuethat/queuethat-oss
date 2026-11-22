import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { LocationServicesPage } from '../../features/admin/services/ServicesPage.tsx';

export const Route = createFileRoute('/admin/services')({
  beforeLoad: () => loadNamespaces('payments'),
  component: LocationServicesPage,
});

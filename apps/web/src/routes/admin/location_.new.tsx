import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { AddLocationPage } from '../../features/admin/location/AddLocationPage.tsx';

export const Route = createFileRoute('/admin/location_/new')({
  beforeLoad: () => loadNamespaces('onboarding'),
  component: AddLocationPage,
});

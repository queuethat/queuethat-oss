import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { LocationSettingsPage } from '../../features/admin/location/LocationSettingsPage.tsx';

export const Route = createFileRoute('/admin/location')({
  beforeLoad: () => loadNamespaces('onboarding'),
  component: LocationSettingsPage,
});

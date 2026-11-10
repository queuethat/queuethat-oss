import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { HoursPage } from '../../features/admin/hours/HoursPage.tsx';

export const Route = createFileRoute('/admin/location_/hours')({
  beforeLoad: () => loadNamespaces('admin-hours'),
  component: HoursPage,
});

import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { ShiftsPage } from '../../features/admin/shifts/ShiftsPage.tsx';

export const Route = createFileRoute('/admin/shifts')({
  beforeLoad: () => loadNamespaces('shifts'),
  component: ShiftsPage,
});

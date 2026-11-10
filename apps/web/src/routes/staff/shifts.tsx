import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../lib/i18n.ts';
import { MyShiftsPage } from '../../features/admin/shifts/ShiftsPage.tsx';

export const Route = createFileRoute('/staff/shifts')({
  beforeLoad: () => loadNamespaces('shifts'),
  component: MyShiftsPage,
});

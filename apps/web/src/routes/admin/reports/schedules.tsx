import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { ReportSchedulesPage } from '../../../features/admin/reports/ReportSchedulesPage.tsx';

export const Route = createFileRoute('/admin/reports/schedules')({
  beforeLoad: () => loadNamespaces('admin-reports'),
  component: ReportSchedulesPage,
});

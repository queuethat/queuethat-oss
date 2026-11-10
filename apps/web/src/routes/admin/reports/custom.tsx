import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { CustomReportPage } from '../../../features/admin/reports/custom/CustomReportPage.tsx';

export const Route = createFileRoute('/admin/reports/custom')({
  beforeLoad: () => loadNamespaces('admin-reports'),
  component: CustomReportPage,
});

import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { AskAnalyticsPage } from '../../../features/admin/reports/ask/AskAnalyticsPage.tsx';

export const Route = createFileRoute('/admin/reports/ask')({
  beforeLoad: () => loadNamespaces('admin-reports'),
  component: AskAnalyticsPage,
});

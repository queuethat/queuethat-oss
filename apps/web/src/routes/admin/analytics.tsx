import { createFileRoute } from '@tanstack/react-router';
import { AnalyticsPage } from '../../features/admin/analytics/AnalyticsPage.tsx';

export const Route = createFileRoute('/admin/analytics')({
  component: AnalyticsPage,
});

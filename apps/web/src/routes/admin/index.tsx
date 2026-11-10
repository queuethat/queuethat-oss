import { createFileRoute } from '@tanstack/react-router';
import { TodayDashboard } from '../../features/admin/dashboard/TodayDashboard.tsx';

export const Route = createFileRoute('/admin/')({
  component: TodayDashboard,
});

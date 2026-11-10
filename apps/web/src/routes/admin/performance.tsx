import { createFileRoute } from '@tanstack/react-router';
import { PerformancePage } from '../../features/admin/performance/PerformancePage.tsx';

export const Route = createFileRoute('/admin/performance')({
  component: PerformancePage,
});

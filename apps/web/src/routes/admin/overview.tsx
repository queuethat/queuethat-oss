import { createFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '../../features/admin/overview/OverviewPage.tsx';

export const Route = createFileRoute('/admin/overview')({
  component: OverviewPage,
});

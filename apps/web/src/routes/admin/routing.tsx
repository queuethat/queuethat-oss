import { createFileRoute } from '@tanstack/react-router';
import { RoutingPage } from '../../features/admin/routing/RoutingPage.tsx';

export const Route = createFileRoute('/admin/routing')({
  component: RoutingPage,
});

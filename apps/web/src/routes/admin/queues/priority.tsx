import { createFileRoute } from '@tanstack/react-router';
import { PriorityPage } from '../../../features/admin/priority/PriorityPage.tsx';

export const Route = createFileRoute('/admin/queues/priority')({
  component: PriorityPage,
});

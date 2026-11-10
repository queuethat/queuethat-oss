import { createFileRoute } from '@tanstack/react-router';
import { QueuesPage } from '../../../features/admin/queues/QueuesPage.tsx';

export const Route = createFileRoute('/admin/queues/')({
  component: QueuesPage,
});

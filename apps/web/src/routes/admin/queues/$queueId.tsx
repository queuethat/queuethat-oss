import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { ServicesPage } from '../../../features/admin/services/ServicesPage.tsx';

export const Route = createFileRoute('/admin/queues/$queueId')({
  beforeLoad: () => loadNamespaces('payments'),
  component: function QueueServices() {
    const { queueId } = Route.useParams();
    return <ServicesPage queueId={queueId} />;
  },
});

import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { QueueOverridesPage } from '../../../features/admin/queues/overrides/QueueOverridesPage.tsx';

export const Route = createFileRoute('/admin/queues/$queueId_/messages')({
  beforeLoad: () => loadNamespaces('admin-templates'),
  component: function QueueMessages() {
    const { queueId } = Route.useParams();
    return <QueueOverridesPage queueId={queueId} />;
  },
});

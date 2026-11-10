import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { FailedMessages } from '../../../features/admin/notifications/FailedMessages.tsx';

export const Route = createFileRoute('/admin/notifications/failed')({
  beforeLoad: () => loadNamespaces('staff'),
  component: FailedMessages,
});

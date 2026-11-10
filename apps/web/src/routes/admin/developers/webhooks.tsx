import { createFileRoute } from '@tanstack/react-router';
import { loadNamespaces } from '../../../lib/i18n.ts';
import { WebhooksPage } from '../../../features/admin/developers/webhooks/WebhooksPage.tsx';

export const Route = createFileRoute('/admin/developers/webhooks')({
  beforeLoad: () => loadNamespaces('admin-webhooks'),
  component: WebhooksPage,
});
